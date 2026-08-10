import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { injectPluginDirRoots } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { discoverExtensionPaths } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

function requireDescriptor(value: unknown): object {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`expected an extension source descriptor, got ${String(value)}`);
	}
	return value;
}

describe("extension source authority", () => {
	let tempHome: string;
	let cwd: string;
	let pluginRoot: string;
	let packagedEntry: string;
	let standaloneEntry: string;
	const originalAgentDir = getAgentDir();

	beforeEach(async () => {
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
						routingMode: { type: "string", enum: ["off", "observe", "enforce"], default: "off" },
						orchestrationPolicy: { type: "string", enum: ["manual", "always"], default: "manual" },
					},
				},
			}),
		);
		await fs.writeFile(packagedEntry, "export default function () {}\n");
		await fs.writeFile(standaloneEntry, "export default function () {}\n");
	});

	afterEach(async () => {
		await injectPluginDirRoots(tempHome, [], cwd);
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempHome);
	});

	it("carries manifest authority and defaults only for a packaged --plugin-dir entry", async () => {
		await injectPluginDirRoots(tempHome, [pluginRoot], cwd);
		const discovered: unknown = await discoverExtensionPaths([], cwd, undefined, { ambient: true });
		expect(Array.isArray(discovered)).toBe(true);
		if (!Array.isArray(discovered)) throw new Error("expected extension source descriptors");
		const packaged = discovered
			.map(requireDescriptor)
			.find(source => "resolvedPath" in source && source.resolvedPath === packagedEntry);

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
					routingMode: { default: "off" },
					orchestrationPolicy: { default: "manual" },
				},
			},
		});
	});

	it("does not infer package authority for an explicitly loaded standalone file", async () => {
		const discovered: unknown = await discoverExtensionPaths([standaloneEntry], cwd, undefined, { ambient: false });
		expect(Array.isArray(discovered)).toBe(true);
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
});
