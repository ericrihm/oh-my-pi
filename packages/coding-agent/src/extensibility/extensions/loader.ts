/**
 * Extension loader - loads TypeScript extension modules using native Bun import.
 */
import type * as fs1 from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	ImageContent,
	Model,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
	TextContent,
	TSchema,
} from "@oh-my-pi/pi-ai";
import type { KeyId } from "@oh-my-pi/pi-tui";
import { hasFsCode, isEacces, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { type ExtensionModule, extensionModuleCapability } from "../../capability/extension-module";
import { type Hook, hookCapability } from "../../capability/hook";
import { isServiceTierFamily, isServiceTierForFamily } from "../../config/service-tier";
import { loadCapability } from "../../discovery";
import { getExtensionNameFromPath } from "../../discovery/helpers";
import { getInjectedOmpExtensionCliRoots } from "../../discovery/omp-extension-roots";
import type { ExecOptions } from "../../exec/exec";
import { execCommand } from "../../exec/exec";
// Runtime self-reference: dereference this namespace only inside loader functions to keep the index.ts cycle safe.
import * as PiCodingAgent from "../../index";
import type { CustomMessagePayload } from "../../session/messages";
import { EventBus } from "../../utils/event-bus";
import * as TypeBox from "../legacy-typebox";
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from "../plugins/legacy-pi-compat";
import { getAllPluginExtensionPaths } from "../plugins/loader";
import type { PluginManifest, PluginSettingSchema } from "../plugins/types";

import { resolvePath, withHostGuard } from "../utils";
import type {
	AssistantThinkingRenderer,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionSourceDescriptor,
	ExtensionRuntime as IExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	RegisteredTaskRouter,
	TaskRouterRegistration,
	ToolDefinition,
	ToolInfo,
} from "./types";

installLegacyPiSpecifierShim();

type HandlerFn = (...args: unknown[]) => Promise<unknown>;
type LoadedExtensionModule = ExtensionFactory | { default?: ExtensionFactory };

function getExtensionFactory(module: LoadedExtensionModule): ExtensionFactory | null {
	const candidate = typeof module === "function" ? module : module.default;
	return typeof candidate === "function" ? candidate : null;
}

export class ExtensionRuntimeNotInitializedError extends Error {
	constructor() {
		super("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	}
}

/**
 * Extension runtime with throwing stubs for action methods.
 * These are replaced with real implementations during initialization.
 */
export class ExtensionRuntime implements IExtensionRuntime {
	flagValues = new Map<string, boolean | string>();
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; sourceId: string }> = [];

	registerProvider(name: string, config: ProviderConfig, sourceId: string): void {
		this.pendingProviderRegistrations.push({ name, config, sourceId });
	}

	unregisterProvider(name: string): void {
		const remaining = this.pendingProviderRegistrations.filter(registration => registration.name !== name);
		this.pendingProviderRegistrations.splice(0, this.pendingProviderRegistrations.length, ...remaining);
	}

	sendMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	sendUserMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	appendEntry(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setLabel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getActiveTools(): string[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getAllTools(): ToolInfo[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setActiveTools(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getCommands(): never {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setModel(): Promise<boolean> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getThinkingLevel(): ThinkingLevel {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setThinkingLevel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getServiceTiers(): ServiceTierByFamily {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setServiceTier(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getSessionName(): string | undefined {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setSessionName(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}
}

/**
 * ExtensionAPI implementation for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
class ConcreteExtensionAPI implements ExtensionAPI, IExtensionRuntime {
	readonly logger = logger;
	readonly typebox = TypeBox;
	readonly arktype = type;
	readonly zod = zod;
	readonly flagValues = new Map<string, boolean | string>();
	readonly pendingProviderRegistrations: Array<{
		name: string;
		config: ProviderConfig;
		sourceId: string;
	}> = [];

	constructor(
		public readonly pi: typeof PiCodingAgent,
		private readonly extension: Extension,
		private readonly runtime: IExtensionRuntime,
		private readonly cwd: string,
		public readonly events: EventBus,
	) {}

	registerTaskRouter(router: TaskRouterRegistration): void {
		if (this.extension.taskRouter) {
			throw new Error(
				`Task router "${router.id}" conflicts with already registered router "${this.extension.taskRouter.registration.id}"`,
			);
		}
		if (router.apiVersion !== 1) {
			throw new Error(`Task router "${router.id}" requires unsupported API version ${String(router.apiVersion)}`);
		}
		const requiredVersion = this.extension.source.manifest?.taskRouterApiVersion;
		if (this.extension.source.sourceKind === "packaged" && requiredVersion !== router.apiVersion) {
			throw new Error(
				`Task router "${router.id}" API version ${router.apiVersion} does not match package requirement ${String(requiredVersion)}`,
			);
		}
		this.extension.taskRouter = { registration: router, source: this.extension.source };
	}

	on<F extends HandlerFn>(event: string, handler: F): void {
		const list = this.extension.handlers.get(event) ?? [];
		list.push(handler);
		this.extension.handlers.set(event, list);
	}

	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void {
		this.extension.tools.set(tool.name, {
			definition: tool,
			extensionPath: this.extension.path,
		});
	}

	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void {
		this.extension.commands.set(name, { name, ...options });
	}

	setLabel(label: string): void {
		this.extension.label = label;
	}

	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void {
		this.extension.shortcuts.set(shortcut, { shortcut, extensionPath: this.extension.path, ...options });
	}

	registerFlag(
		name: string,
		options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
	): void {
		this.extension.flags.set(name, { name, extensionPath: this.extension.path, ...options });
		if (options.default !== undefined) {
			this.runtime.flagValues.set(name, options.default);
		}
	}

	registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
		this.extension.messageRenderers.set(customType, renderer as MessageRenderer);
	}

	registerAssistantThinkingRenderer(renderer: AssistantThinkingRenderer): void {
		this.extension.assistantThinkingRenderers.push(renderer);
	}

	getFlag(name: string): boolean | string | undefined {
		if (!this.extension.flags.has(name)) return undefined;
		return this.runtime.flagValues.get(name);
	}

	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void {
		this.runtime.sendMessage(message, options);
	}

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void {
		this.runtime.sendUserMessage(content, options);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.runtime.appendEntry(customType, data);
	}

	exec(command: string, args: string[], options?: ExecOptions) {
		return execCommand(command, args, options?.cwd ?? this.cwd, options);
	}

	getActiveTools(): string[] {
		return this.runtime.getActiveTools();
	}

	getAllTools(): ToolInfo[] {
		return this.runtime.getAllTools();
	}

	setActiveTools(toolNames: string[]): Promise<void> {
		return this.runtime.setActiveTools(toolNames);
	}

	getCommands() {
		return this.runtime.getCommands();
	}

	setModel(model: Model): Promise<boolean> {
		return this.runtime.setModel(model);
	}

	getThinkingLevel(): ThinkingLevel | undefined {
		return this.runtime.getThinkingLevel();
	}

	setThinkingLevel(level: ThinkingLevel, persist?: boolean): void {
		this.runtime.setThinkingLevel(level, persist);
	}

	getServiceTiers(): Readonly<ServiceTierByFamily> {
		return { ...this.runtime.getServiceTiers() };
	}

	setServiceTier(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		if (!isServiceTierFamily(family) || (tier !== undefined && !isServiceTierForFamily(family, tier))) {
			throw new TypeError(`Invalid service tier "${String(tier)}" for family "${String(family)}"`);
		}
		this.runtime.setServiceTier(family, tier);
	}

	getSessionName(): string | undefined {
		return this.runtime.getSessionName();
	}

	setSessionName(name: string): Promise<void> {
		return this.runtime.setSessionName(name);
	}

	registerProvider(name: string, config: ProviderConfig): void {
		this.runtime.registerProvider(name, config, this.extension.path);
	}

	unregisterProvider(name: string): void {
		this.runtime.unregisterProvider(name, this.extension.path);
	}
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string, source: ExtensionSourceDescriptor): Extension {
	return {
		path: extensionPath,
		resolvedPath,
		source,
		handlers: new Map(),
		tools: new Map(),
		assistantThinkingRenderers: [],
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

/**
 * Runs an extension factory with provider registration rollback on failure.
 * Restores the complete registration queue when the factory throws because an
 * extension may unregister entries queued by an earlier extension.
 */
async function runExtensionFactory(
	factory: ExtensionFactory,
	api: ExtensionAPI,
	runtime: IExtensionRuntime,
): Promise<void> {
	const providerRegistrationCheckpoint = [...runtime.pendingProviderRegistrations];

	try {
		await factory(api);
	} catch (error) {
		runtime.pendingProviderRegistrations.splice(
			0,
			runtime.pendingProviderRegistrations.length,
			...providerRegistrationCheckpoint,
		);
		throw error;
	}
}

interface ImportedExtensionModule {
	factory: ExtensionFactory | null;
	resolvedPath: string;
	error: string | null;
}

async function importExtensionModule(extensionPath: string, cwd: string): Promise<ImportedExtensionModule> {
	const resolvedPath = resolvePath(extensionPath, cwd);
	try {
		const module = (await withHostGuard(() => loadLegacyPiModule(resolvedPath))) as LoadedExtensionModule;
		const factory = getExtensionFactory(module);

		if (typeof factory !== "function") {
			return {
				factory: null,
				resolvedPath,
				error: `Extension does not export a valid factory function: ${extensionPath}`,
			};
		}

		return { factory, resolvedPath, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { factory: null, resolvedPath, error: `Failed to load extension: ${message}` };
	}
}

async function bindExtension(
	source: ExtensionSourceDescriptor,
	imported: ImportedExtensionModule,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
): Promise<{ extension: Extension | null; error: string | null }> {
	const extensionPath = source.resolvedPath;
	const factory = imported.factory;
	if (imported.error !== null || factory === null) {
		return { extension: null, error: imported.error };
	}
	try {
		const extension = createExtension(extensionPath, imported.resolvedPath, source);
		const api = new ConcreteExtensionAPI(PiCodingAgent, extension, runtime, cwd, eventBus);
		await withHostGuard(() => runExtensionFactory(factory, api, runtime));

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	name = "<inline>",
): Promise<Extension> {
	const source: ExtensionSourceDescriptor = { resolvedPath: name, sourceKind: "standalone", loadKind: "configured" };
	const extension = createExtension(name, name, source);
	const api = new ConcreteExtensionAPI(PiCodingAgent, extension, runtime, cwd, eventBus);
	await runExtensionFactory(factory, api, runtime);
	return extension;
}

/**
 * Load extensions from paths.
 *
 * Module import (the dominant cold-start cost — file I/O plus module
 * evaluation) runs concurrently across extensions; factory binding then runs
 * sequentially in the original path order, so registration semantics
 * (last-wins collisions, shared runtime flag defaults) stay deterministic.
 */
export async function loadExtensions(
	sources: readonly (ExtensionSourceDescriptor | string)[],
	cwd: string,
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const normalizedSources = sources.map(
		(source): ExtensionSourceDescriptor =>
			typeof source === "string"
				? { resolvedPath: path.resolve(cwd, source), sourceKind: "standalone", loadKind: "configured" }
				: source,
	);
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? new EventBus();
	const runtime = new ExtensionRuntime();
	const imported = await Promise.all(normalizedSources.map(source => importExtensionModule(source.resolvedPath, cwd)));
	let taskRouter: RegisteredTaskRouter | undefined;

	for (let i = 0; i < normalizedSources.length; i++) {
		const source = normalizedSources[i]!;
		const { extension, error } = await bindExtension(source, imported[i]!, cwd, resolvedEventBus, runtime);
		if (error) {
			errors.push({ path: source.resolvedPath, error });
			continue;
		}
		if (extension) {
			if (extension.taskRouter) {
				if (taskRouter) {
					throw new Error(
						`Task router "${extension.taskRouter.registration.id}" conflicts with already registered router "${taskRouter.registration.id}"`,
					);
				}
				taskRouter = extension.taskRouter;
			}
			extensions.push(extension);
		}
	}

	return { extensions, errors, runtime, taskRouter, sources: normalizedSources };
}

interface ExtensionManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
	taskRouterApiVersion?: number;
	settings?: Record<string, PluginSettingSchema>;
}

interface ExtensionPackageJson {
	name?: string;
	version?: string;
	omp?: ExtensionManifest;
	pi?: ExtensionManifest;
}

async function readExtensionPackage(packageJsonPath: string): Promise<ExtensionPackageJson | null> {
	try {
		const pkg = (await Bun.file(packageJsonPath).json()) as ExtensionPackageJson;
		return pkg && typeof pkg === "object" ? pkg : null;
	} catch (error) {
		if (isEnoent(error) || isEacces(error) || hasFsCode(error, "EPERM")) return null;
		logger.warn("Failed to read extension manifest", { path: packageJsonPath, error: String(error) });
		return null;
	}
}

async function readExtensionManifest(packageJsonPath: string): Promise<ExtensionManifest | null> {
	const pkg = await readExtensionPackage(packageJsonPath);
	return pkg?.omp ?? pkg?.pi ?? null;
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 */
async function resolveExtensionEntries(dir: string): Promise<string[] | null> {
	const packageJsonPath = path.join(dir, "package.json");
	const manifest = await readExtensionManifest(packageJsonPath);
	if (manifest?.extensions?.length) {
		const entries: string[] = [];
		for (const extPath of manifest.extensions) {
			const resolvedExtPath = path.resolve(dir, extPath);
			try {
				await fs.stat(resolvedExtPath);
				entries.push(resolvedExtPath);
			} catch (err) {
				if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) continue;
				throw err;
			}
		}
		if (entries.length > 0) {
			return entries;
		}
	}

	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	try {
		await fs.stat(indexTs);
		return [indexTs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
			// Ignore
		} else {
			throw err;
		}
	}
	try {
		await fs.stat(indexJs);
		return [indexJs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
			// Ignore
		} else {
			throw err;
		}
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/<ext>/index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/<ext>/package.json` with "omp"/"pi" field → load declared paths
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
async function discoverExtensionsInDir(dir: string): Promise<string[]> {
	const discovered: string[] = [];

	// First check if this directory itself has explicit extension entries (package.json or index)
	const rootEntries = await resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	// Otherwise, discover extensions from directory contents
	let entries: fs1.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Failed to discover extensions in directory", { path: dir, error: String(err) });
		return [];
	}

	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);

		if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
			discovered.push(entryPath);
			continue;
		}

		if (entry.isDirectory() || entry.isSymbolicLink()) {
			const resolved = await resolveExtensionEntries(entryPath);
			if (resolved) {
				discovered.push(...resolved);
			}
		}
	}

	return discovered;
}
async function discoverHooksInPackageRoot(root: string): Promise<string[]> {
	const hooks: string[] = [];
	for (const hookType of ["pre", "post"]) {
		const hookDir = path.join(root, "hooks", hookType);
		let entries: fs1.Dirent[];
		try {
			entries = await fs.readdir(hookDir, { withFileTypes: true });
		} catch (err) {
			if (isEnoent(err) || isEacces(err) || hasFsCode(err, "ENOTDIR") || hasFsCode(err, "EPERM")) continue;
			throw err;
		}
		for (const entry of entries) {
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				hooks.push(path.join(hookDir, entry.name));
			}
		}
	}
	return hooks;
}

function validateManifestSettings(
	packageName: string,
	settings: Record<string, PluginSettingSchema> | undefined,
): void {
	for (const [key, schema] of Object.entries(settings ?? {})) {
		if (!schema || typeof schema !== "object" || !["string", "number", "boolean", "enum"].includes(schema.type)) {
			throw new Error(`Plugin ${packageName} setting ${key} has invalid type`);
		}
		const commonKeys = ["type", "description", "secret", "env", "default"];
		const typeKeys = schema.type === "number" ? ["min", "max", "step"] : schema.type === "enum" ? ["values"] : [];
		const unknownKey = Object.keys(schema).find(key => !commonKeys.includes(key) && !typeKeys.includes(key));
		if (unknownKey) throw new Error(`Plugin ${packageName} setting ${key} has invalid field ${unknownKey}`);
		if (
			schema.type === "enum" &&
			(!Array.isArray(schema.values) || schema.values.some(value => typeof value !== "string"))
		) {
			throw new Error(`Plugin ${packageName} setting ${key} enum requires string values`);
		}
		if (schema.default !== undefined) {
			const validDefault =
				(schema.type === "string" && typeof schema.default === "string") ||
				(schema.type === "number" && typeof schema.default === "number") ||
				(schema.type === "boolean" && typeof schema.default === "boolean") ||
				(schema.type === "enum" && schema.values.includes(String(schema.default)));
			if (!validDefault) throw new Error(`Plugin ${packageName} setting ${key} has invalid default`);
		}
	}
}

async function describeExtensionSource(
	extPath: string,
	loadKind: ExtensionSourceDescriptor["loadKind"],
): Promise<ExtensionSourceDescriptor> {
	const resolvedPath = path.resolve(extPath);
	let cursor = path.dirname(resolvedPath);
	for (;;) {
		const pkg = await readExtensionPackage(path.join(cursor, "package.json"));
		const manifest = pkg?.omp ?? pkg?.pi;
		if (pkg && manifest?.extensions?.some(entry => path.resolve(cursor, entry) === resolvedPath)) {
			const packageName = pkg.name ?? path.basename(cursor);
			validateManifestSettings(packageName, manifest.settings);
			const descriptorManifest: PluginManifest = {
				version: pkg.version ?? "0.0.0",
				...manifest,
			};
			return {
				resolvedPath,
				sourceKind: "packaged",
				loadKind,
				packageRoot: cursor,
				packageName,
				packageVersion: pkg.version,
				manifest: descriptorManifest,
			};
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	return { resolvedPath, sourceKind: "standalone", loadKind };
}

/**
 * Discover absolute paths of extensions to load, without importing or
 * binding factories. Hot path on session startup — the scan walks native
 * `.omp`/`.pi` extension capabilities, JS/TS hook factories, the
 * installed-plugin tree, and any configured paths.
 *
 * Subagents reuse the parent's collected source descriptors via the SDK's
 * `preloadedExtensionSources` option, then call {@link loadExtensions} themselves
 * so each session rebuilds Extension instances bound to its own runtime while
 * preserving package authority.
 */
export interface DiscoverExtensionPathOptions {
	/** Include ambient native extensions, hooks, and installed plugins. */
	ambient?: boolean;
}

export async function discoverExtensionSources(
	configuredPaths: string[],
	cwd: string,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<ExtensionSourceDescriptor[]> {
	const allSources: ExtensionSourceDescriptor[] = [];
	const seen = new Set<string>();
	const disabled = new Set(disabledExtensionIds ?? []);
	const loadOptions = disabledExtensionIds ? { cwd, disabledExtensions: disabledExtensionIds } : { cwd };
	const injectedRoots = getInjectedOmpExtensionCliRoots().map(root => path.resolve(root.path));
	const isDisabledName = (name: string): boolean => disabled.has(`extension-module:${name}`);
	const ambientLoadKind = (extPath: string): ExtensionSourceDescriptor["loadKind"] =>
		injectedRoots.some(root => path.resolve(extPath).startsWith(`${root}${path.sep}`)) ? "explicit" : "discovered";

	const addPath = async (extPath: string, loadKind: ExtensionSourceDescriptor["loadKind"]): Promise<void> => {
		const resolved = path.resolve(extPath);
		if (seen.has(resolved) || isDisabledName(getExtensionNameFromPath(extPath))) return;
		seen.add(resolved);
		allSources.push(await describeExtensionSource(resolved, loadKind));
	};
	const addPaths = async (paths: string[], loadKind: ExtensionSourceDescriptor["loadKind"]) => {
		for (const extPath of paths) await addPath(extPath, loadKind);
	};

	const ambient = options.ambient !== false;
	if (ambient) {
		for (const root of injectedRoots) {
			const entries = await resolveExtensionEntries(root);
			if (entries) await addPaths(entries, "explicit");
		}
	}
	if (ambient) {
		const discovered = await loadCapability<ExtensionModule>(extensionModuleCapability.id, {
			...loadOptions,
			providers: ["native"],
		});
		for (const ext of discovered.items) await addPath(ext.path, ambientLoadKind(ext.path));
	}

	if (ambient) {
		const hooks = await loadCapability<Hook>(hookCapability.id, loadOptions);
		for (const hookPath of hooks.items
			.map(hook => hook.path)
			.filter(hookPath => isExtensionFile(path.basename(hookPath)))) {
			await addPath(hookPath, ambientLoadKind(hookPath));
		}
	} else {
		for (const configuredPath of configuredPaths) {
			await addPaths(await discoverHooksInPackageRoot(resolvePath(configuredPath, cwd)), "configured");
		}
	}

	if (ambient) {
		for (const extPath of await getAllPluginExtensionPaths(cwd)) {
			await addPath(extPath, ambientLoadKind(extPath));
		}
	}

	for (const configuredPath of configuredPaths) {
		const resolved = resolvePath(configuredPath, cwd);
		let stat: fs1.Stats | null = null;
		try {
			stat = await fs.stat(resolved);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		if (stat?.isDirectory()) {
			const entries = await resolveExtensionEntries(resolved);
			if (entries) {
				await addPaths(entries, "configured");
				continue;
			}
			await addPaths(await discoverExtensionsInDir(resolved), "configured");
			continue;
		}
		await addPath(resolved, "configured");
	}

	return allSources;
}
/** Compatibility path-only view for callers that do not need provenance. */
export async function discoverExtensionPaths(
	configuredPaths: string[],
	cwd: string,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<string[]> {
	return (await discoverExtensionSources(configuredPaths, cwd, disabledExtensionIds, options)).map(
		source => source.resolvedPath,
	);
}

/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	eventBus?: EventBus,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<LoadExtensionsResult> {
	const sources = await discoverExtensionSources(configuredPaths, cwd, disabledExtensionIds, options);
	return loadExtensions(sources, cwd, eventBus);
}
