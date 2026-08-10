import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	clearOmpExtensionCliRoots,
	injectOmpExtensionCliRoots,
} from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import {
	discoverExtensionSources,
	ExtensionRuntime,
	type ExtensionSourceDescriptor,
	loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getAgentDir, getPluginsLockfile, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

interface SourceProbe {
	registrations: number;
	routes: number;
	sources: unknown[];
	settings: unknown[];
	executions: unknown[];
}

declare global {
	var __ompSourceAuthorityProbe: SourceProbe | undefined;
}

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};
const restrictedAgent: AgentDefinition = {
	...taskAgent,
	name: "restricted",
	description: "Restricted task agent",
	tools: ["read"],
};

function requireDescriptor(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`expected an extension source descriptor, got ${String(value)}`);
	}
	return value as Record<string, unknown>;
}

function readField(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object" || !(key in value)) return undefined;
	return (value as Record<string, unknown>)[key];
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

function completedResult(index: number, assignment: string): SingleResult {
	return {
		index,
		id: `source-${index}`,
		agent: "task",
		agentSource: "bundled",
		task: assignment,
		assignment,
		exitCode: 0,
		output: `ran:${assignment}`,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

describe("extension source authority", () => {
	let tempHome: string;
	let cwd: string;
	let pluginRoot: string;
	let packagedEntry: string;
	let standaloneEntry: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: Array<{ dispose(): Promise<void> }> = [];
	const originalAgentDir = getAgentDir();

	beforeAll(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-source-red-"));
		cwd = path.join(tempHome, "project");
		pluginRoot = path.join(tempHome, "regulus-plugin");
		packagedEntry = path.join(pluginRoot, "dist", "index.ts");
		standaloneEntry = path.join(pluginRoot, "scratch", "standalone.ts");
		await fs.mkdir(path.dirname(packagedEntry), { recursive: true });
		await fs.mkdir(path.dirname(standaloneEntry), { recursive: true });
		await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		await fs.writeFile(
			path.join(pluginRoot, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "regulus-source-probe", version: "1.2.0" }),
		);
		await fs.writeFile(
			path.join(pluginRoot, "package.json"),
			JSON.stringify({
				name: "regulus-source-probe",
				version: "1.2.0",
				type: "module",
				omp: {
					extensions: ["./dist/index.ts"],
					taskRouterApiVersion: 1,
					settings: {
						routingMode: {
							type: "enum",
							values: ["off", "observe", "enforce"],
							default: "off",
						},
						orchestrationPolicy: {
							type: "enum",
							values: ["manual", "always"],
							default: "manual",
						},
					},
				},
			}),
		);
		await fs.writeFile(
			packagedEntry,
			[
				"export default function (pi) {",
				"  const probe = globalThis.__ompSourceAuthorityProbe;",
				"  probe.registrations += 1;",
				"  pi.registerTaskRouter({",
				"    id: 'source-probe',",
				"    apiVersion: 1,",
				"    async route(_request, ctx) {",
				"      probe.routes += 1;",
				"      probe.sources.push(ctx.source);",
				"      probe.settings.push({",
				"        routingMode: ctx.settings.get('routingMode'),",
				"        orchestrationPolicy: ctx.settings.get('orchestrationPolicy'),",
				"      });",
				"      return null;",
				"    },",
				"  });",
				"}",
			].join("\n"),
		);
		await fs.writeFile(standaloneEntry, "export default function () {}\n");
		authStorage = await AuthStorage.create(path.join(tempHome, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempHome, "models.yml"));
	});

	beforeEach(() => {
		globalThis.__ompSourceAuthorityProbe = { registrations: 0, routes: 0, sources: [], settings: [], executions: [] };
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent, restrictedAgent],
			projectAgentsDir: null,
		});
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	afterAll(async () => {
		clearOmpExtensionCliRoots();
		authStorage.close();
		delete globalThis.__ompSourceAuthorityProbe;
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempHome);
	});

	async function discoverPackagedSource(): Promise<ExtensionSourceDescriptor> {
		injectOmpExtensionCliRoots([pluginRoot], tempHome, cwd, { replace: true });
		const discovered = await discoverExtensionSources([], cwd, undefined, { ambient: true });
		const packaged = discovered.find(source => source.resolvedPath === packagedEntry);
		if (!packaged) throw new Error("packaged extension source was not discovered");
		return packaged;
	}

	async function createSessionFromSources(sources: ExtensionSourceDescriptor[], parentTaskPrefix?: string) {
		const options = {
			cwd,
			agentDir: getAgentDir(),
			sessionManager: SessionManager.inMemory(cwd),
			modelRegistry,
			settings: Settings.isolated({
				"task.batch": true,
				"task.isolation.mode": "none",
				"async.enabled": true,
			}),
			preloadedExtensionSources: sources,
			parentTaskPrefix,
			toolNames: ["task"],
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
		};
		const created = await createAgentSession(options);
		sessions.push(created.session);
		const tool = created.session.agent.state.tools.find(candidate => candidate.name === "task");
		if (!tool) throw new Error("task tool was not assembled");
		return { session: created.session, tool };
	}

	it("carries valid manifest authority and defaults in a packaged --plugin-dir descriptor", async () => {
		const packaged = await discoverPackagedSource();

		expect(packaged).toMatchObject({
			resolvedPath: packagedEntry,
			sourceKind: "packaged",
			loadKind: "explicit",
			packageRoot: pluginRoot,
			packageName: "regulus-source-probe",
			packageVersion: "1.2.0",
			manifest: {
				taskRouterApiVersion: 1,
				settings: {
					routingMode: { type: "enum", values: ["off", "observe", "enforce"], default: "off" },
					orchestrationPolicy: { type: "enum", values: ["manual", "always"], default: "manual" },
				},
			},
		});
	});

	it("refuses invalid plugin setting grammar during source discovery", async () => {
		const invalidRoot = path.join(tempHome, "invalid-plugin");
		await fs.mkdir(invalidRoot, { recursive: true });
		await fs.writeFile(path.join(invalidRoot, "index.ts"), "export default function () {}\n");
		await fs.writeFile(
			path.join(invalidRoot, "package.json"),
			JSON.stringify({
				name: "invalid-source-probe",
				version: "1.0.0",
				omp: {
					extensions: ["./index.ts"],
					settings: { routingMode: { type: "string", enum: ["off", "observe"], default: "observe" } },
				},
			}),
		);
		injectOmpExtensionCliRoots([invalidRoot], tempHome, cwd, { replace: true });

		await expect(discoverExtensionSources([], cwd, undefined, { ambient: true })).rejects.toThrow(
			/invalid-source-probe.*routingMode|routingMode.*type.*enum/i,
		);
	});
	it("enforces exclusive router registration within one extension", async () => {
		await expect(
			loadExtensionFromFactory(
				pi => {
					const router = { id: "duplicate", apiVersion: 1 as const, route: async () => null };
					pi.registerTaskRouter(router);
					pi.registerTaskRouter(router);
				},
				cwd,
				new EventBus(),
				new ExtensionRuntime(),
			),
		).rejects.toThrow(/conflicts with already registered router/i);
	});
	it("keeps standalone configured files outside package authority", async () => {
		const discovered: unknown = await discoverExtensionSources([standaloneEntry], cwd, undefined, { ambient: false });
		if (!Array.isArray(discovered)) throw new Error("expected extension source descriptors");
		const standalone = requireDescriptor(discovered[0]);

		expect(standalone).toMatchObject({
			resolvedPath: standaloneEntry,
			sourceKind: "standalone",
			loadKind: "configured",
		});
		expect(standalone).not.toHaveProperty("packageRoot");
		expect(standalone).not.toHaveProperty("packageName");
		expect(standalone).not.toHaveProperty("packageVersion");
		expect(standalone).not.toHaveProperty("manifest");
	});

	it("preserves explicit package authority through a real nested subagent session rebuild", async () => {
		const packaged = await discoverPackagedSource();
		expect(await Bun.file(getPluginsLockfile()).exists()).toBe(false);
		const parent = await createSessionFromSources([packaged]);
		expect(readField(parent.session, "extensionSources")).toEqual([packaged]);
		expect(globalThis.__ompSourceAuthorityProbe).toMatchObject({ registrations: 1 });

		const realCreateAgentSession = sdkModule.createAgentSession;
		const rebuilt: Array<{ options: unknown; session: unknown }> = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const created = await realCreateAgentSession(options);
			rebuilt.push({ options, session: created.session });
			Object.defineProperty(created.session, "prompt", {
				configurable: true,
				value: async () => {
					throw new Error("stop after real nested session rebuild");
				},
			});
			return created;
		});

		const acceptance = await parent.tool.execute("nested", {
			agent: "task",
			task: "Build a real child session.",
		} as never);
		expect(firstText(acceptance)).toMatch(/Spawned agent/i);
		await Promise.all((parent.session.asyncJobManager?.getAllJobs() ?? []).map(job => job.promise));

		expect(rebuilt).toHaveLength(1);
		expect(readField(rebuilt[0]?.options, "preloadedExtensionSources")).toEqual([packaged]);
		expect(readField(rebuilt[0]?.session, "extensionSources")).toEqual([packaged]);
		expect(globalThis.__ompSourceAuthorityProbe).toMatchObject({
			registrations: 2,
			settings: expect.arrayContaining([{ routingMode: "off", orchestrationPolicy: "manual" }]),
		});
	});

	it("clears package authority when restricted nested execution resets extension isolation", async () => {
		const packaged = await discoverPackagedSource();
		const parent = await createSessionFromSources([packaged]);
		const realCreateAgentSession = sdkModule.createAgentSession;
		const rebuilt: Array<{ options: unknown; session: unknown }> = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const created = await realCreateAgentSession(options);
			rebuilt.push({ options, session: created.session });
			Object.defineProperty(created.session, "prompt", {
				configurable: true,
				value: async () => {
					throw new Error("stop after restricted nested session rebuild");
				},
			});
			return created;
		});

		await parent.tool.execute("restricted", {
			agent: "restricted",
			task: "Run without inherited authority.",
		} as never);
		await Promise.all((parent.session.asyncJobManager?.getAllJobs() ?? []).map(job => job.promise));

		expect(rebuilt).toHaveLength(1);
		expect(readField(rebuilt[0]?.options, "preloadedExtensionSources")).toEqual([]);
		expect(readField(rebuilt[0]?.session, "extensionSources")).toEqual([]);
		expect(globalThis.__ompSourceAuthorityProbe).toMatchObject({ registrations: 1 });
	});

	it("checks linked enablement and settings freshly on every routed task", async () => {
		const [packaged] = await discoverExtensionSources([pluginRoot], cwd, undefined, { ambient: false });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			globalThis.__ompSourceAuthorityProbe?.executions.push(options);
			return completedResult(options.index ?? 0, options.assignment ?? "");
		});
		const { tool } = await createSessionFromSources([packaged]);
		await tool.execute("explicit", { agent: "task", task: "Explicit load." } as never);
		expect(globalThis.__ompSourceAuthorityProbe?.routes).toBe(1);

		const manager = new PluginManager(cwd);
		await manager.link(pluginRoot);
		await manager.setEnabled("regulus-source-probe", false);
		await tool.execute("disabled", { agent: "task", task: "Disabled link." } as never);
		expect(globalThis.__ompSourceAuthorityProbe?.routes).toBe(1);

		await manager.setEnabled("regulus-source-probe", true);
		await manager.setPluginSetting("regulus-source-probe", "routingMode", "off");
		await tool.execute("off", { agent: "task", task: "Routing off." } as never);
		expect(globalThis.__ompSourceAuthorityProbe?.routes).toBe(1);

		await manager.setPluginSetting("regulus-source-probe", "routingMode", "observe");
		await tool.execute("observe", { agent: "task", task: "Routing observed." } as never);
		expect(globalThis.__ompSourceAuthorityProbe).toMatchObject({
			routes: 2,
			settings: expect.arrayContaining([{ routingMode: "observe", orchestrationPolicy: "manual" }]),
		});
	});
});
