import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as runnerModule from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

interface RouterProbe {
	mode: "null" | "reject" | "hang";
	registrations: number;
	requests: Array<{ taskCwd?: string; items?: Array<{ index?: number; agent?: string; task?: string }> }>;
	entered: boolean;
	enteredPromise: Promise<void>;
	signalEntered(): void;
	aborted: boolean;
}

declare global {
	var __ompTaskRouterProbe: RouterProbe | undefined;
}

interface RunnerTestApi {
	TASK_ROUTER_TIMEOUT_MS?: number;
	testSetTaskRouterTimeoutMs?: (timeoutMs: number) => void;
}

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};
const scoutAgent: AgentDefinition = {
	...taskAgent,
	name: "scout",
	description: "Repository scout",
};

function newProbe(mode: RouterProbe["mode"] = "null"): RouterProbe {
	const { promise, resolve } = Promise.withResolvers<void>();
	return {
		mode,
		registrations: 0,
		requests: [],
		entered: false,
		enteredPromise: promise,
		signalEntered: resolve,
		aborted: false,
	};
}

function getProbe(): RouterProbe {
	if (!globalThis.__ompTaskRouterProbe) throw new Error("router probe was not initialized");
	return globalThis.__ompTaskRouterProbe;
}

function getRunnerTestApi(): RunnerTestApi {
	const candidate: unknown = runnerModule;
	if (!candidate || typeof candidate !== "object") return {};
	return {
		TASK_ROUTER_TIMEOUT_MS:
			"TASK_ROUTER_TIMEOUT_MS" in candidate && typeof candidate.TASK_ROUTER_TIMEOUT_MS === "number"
				? candidate.TASK_ROUTER_TIMEOUT_MS
				: undefined,
		testSetTaskRouterTimeoutMs:
			"testSetTaskRouterTimeoutMs" in candidate && typeof candidate.testSetTaskRouterTimeoutMs === "function"
				? candidate.testSetTaskRouterTimeoutMs
				: undefined,
	};
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

function resultFor(index: number, agent: string, assignment: string): SingleResult {
	return {
		index,
		id: `test-${index}`,
		agent,
		agentSource: "bundled",
		task: assignment,
		assignment,
		exitCode: 0,
		output: `ran:${agent}:${assignment}`,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

describe("task router SDK bridge", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: Array<{ dispose(): Promise<void> }> = [];

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-router-red-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	beforeEach(() => {
		globalThis.__ompTaskRouterProbe = newProbe();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent, scoutAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			resultFor(options.index ?? 0, options.agent.name, options.assignment),
		);
	});

	afterEach(async () => {
		getRunnerTestApi().testSetTaskRouterTimeoutMs?.(30_000);
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	afterAll(async () => {
		authStorage.close();
		delete globalThis.__ompTaskRouterProbe;
		await removeWithRetries(tempDir);
	});

	async function writeRouter(id: string): Promise<string> {
		const extensionPath = path.join(tempDir, `${id}-${crypto.randomUUID()}.ts`);
		await fs.writeFile(
			extensionPath,
			[
				"export default function (pi) {",
				"  const probe = globalThis.__ompTaskRouterProbe;",
				"  probe.registrations += 1;",
				"  pi.registerTaskRouter({",
				`    id: ${JSON.stringify(id)},`,
				"    apiVersion: 1,",
				"    async route(request, ctx) {",
				"      probe.entered = true;",
				"      probe.signalEntered();",
				"      probe.requests.push(request);",
				"      if (probe.mode === 'reject') throw new Error('fixture route refusal');",
				"      if (probe.mode === 'hang') {",
				"        const pending = Promise.withResolvers();",
				"        ctx.signal.addEventListener('abort', () => {",
				"          probe.aborted = true;",
				"          pending.resolve(null);",
				"        }, { once: true });",
				"        return pending.promise;",
				"      }",
				"      return null;",
				"    },",
				"  });",
				"}",
			].join("\n"),
		);
		return extensionPath;
	}

	async function createSession(extensionPaths: string[] = []) {
		const created = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry,
			settings: Settings.isolated({
				"task.batch": true,
				"task.isolation.mode": "none",
				"async.enabled": true,
			}),
			preloadedExtensionPaths: extensionPaths,
			toolNames: ["task"],
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
		});
		sessions.push(created.session);
		const tool = created.session.agent.state.tools.find(candidate => candidate.name === "task");
		if (!tool) throw new Error("task tool was not assembled");
		return { session: created.session, tool };
	}

	it("delivers validated flat and mixed-batch invocations once through SDK assembly", async () => {
		const extensionPath = await writeRouter("sdk-probe");
		const { tool } = await createSession([extensionPath]);

		await tool.execute("invalid", { agent: "task" } as never);
		expect(getProbe().requests).toHaveLength(0);

		await tool.execute("flat", { agent: "task", task: "Inspect one file." } as never);
		await tool.execute("batch", {
			context: "Shared repository context.",
			tasks: [
				{ agent: "task", task: "Apply the mechanical edit." },
				{ agent: "scout", task: "Map the dependency seam." },
			],
		} as never);

		expect(getProbe().registrations).toBe(1);
		expect(getProbe().requests).toHaveLength(2);
		expect(getProbe().requests[0]).toMatchObject({
			taskCwd: tempDir,
			items: [{ index: 0, agent: "task", task: "Inspect one file." }],
		});
		expect(getProbe().requests[1]?.items).toEqual([
			expect.objectContaining({ index: 0, agent: "task", task: "Apply the mechanical edit." }),
			expect.objectContaining({ index: 1, agent: "scout", task: "Map the dependency seam." }),
		]);
	});

	it("rejects a mixed batch atomically before spawn or async registration", async () => {
		globalThis.__ompTaskRouterProbe = newProbe("reject");
		const extensionPath = await writeRouter("atomic-probe");
		const { session, tool } = await createSession([extensionPath]);
		const runSpy = executorModule.runSubprocess;

		const result = await tool.execute("batch-refusal", {
			context: "Shared.",
			tasks: [
				{ agent: "task", task: "First." },
				{ agent: "scout", task: "Second." },
			],
		} as never);

		expect(firstText(result)).toMatch(/fixture route refusal/i);
		expect(runSpy).not.toHaveBeenCalled();
		expect(session.asyncJobManager?.getAllJobs()).toEqual([]);
	});

	it("rejects multiple routers at startup and names both owners", async () => {
		const first = await writeRouter("router-one");
		const second = await writeRouter("router-two");
		const outcome = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry,
			settings: Settings.isolated(),
			preloadedExtensionPaths: [first, second],
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
		}).then(
			created => ({ session: created.session, error: undefined }),
			error => ({ session: undefined, error }),
		);
		if (outcome.session) sessions.push(outcome.session);

		expect(String(outcome.error)).toMatch(/router-one.*router-two|router-two.*router-one/i);
	});

	it("uses a 30-second route deadline and aborts timed-out routing before registration", async () => {
		// This integration test exercises the real AbortSignal deadline; the exported
		// test seam shortens it without changing the platform timer implementation.
		const runnerTestApi = getRunnerTestApi();
		expect(runnerTestApi.TASK_ROUTER_TIMEOUT_MS).toBe(30_000);
		expect(runnerTestApi.testSetTaskRouterTimeoutMs).toBeFunction();
		runnerTestApi.testSetTaskRouterTimeoutMs?.(10);
		globalThis.__ompTaskRouterProbe = newProbe("hang");
		const extensionPath = await writeRouter("timeout-probe");
		const { session, tool } = await createSession([extensionPath]);
		const runSpy = executorModule.runSubprocess;

		const result = await tool.execute("timeout", { agent: "task", task: "Wait forever." } as never);

		expect(firstText(result)).toMatch(/route.*timed out|timed out.*route/i);
		expect(getProbe().aborted).toBe(true);
		expect(runSpy).not.toHaveBeenCalled();
		expect(session.asyncJobManager?.getAllJobs()).toEqual([]);
	});

	it("propagates caller abort to the router and starts no child", async () => {
		const runnerTestApi = getRunnerTestApi();
		expect(runnerTestApi.testSetTaskRouterTimeoutMs).toBeFunction();
		runnerTestApi.testSetTaskRouterTimeoutMs?.(1_000);
		globalThis.__ompTaskRouterProbe = newProbe("hang");
		const extensionPath = await writeRouter("abort-probe");
		const { session, tool } = await createSession([extensionPath]);
		const controller = new AbortController();
		const execution = tool.execute("abort", { agent: "task", task: "Abort me." } as never, controller.signal);
		await getProbe().enteredPromise;
		controller.abort();
		const result = await execution;

		expect(firstText(result)).toMatch(/abort/i);
		expect(getProbe().aborted).toBe(true);
		expect(executorModule.runSubprocess).not.toHaveBeenCalled();
		expect(session.asyncJobManager?.getAllJobs()).toEqual([]);
	});

	it("preserves current task execution with no router or a null decision", async () => {
		const withoutRouter = await createSession();
		const first = await withoutRouter.tool.execute("no-router", { agent: "task", task: "Run normally." } as never);
		expect(firstText(first)).toMatch(/Spawned agent|ran:task:Run normally/);

		const extensionPath = await writeRouter("null-probe");
		const withNullRouter = await createSession([extensionPath]);
		const second = await withNullRouter.tool.execute("null-router", {
			agent: "task",
			task: "Run normally.",
		} as never);
		expect(firstText(second)).toMatch(/Spawned agent|ran:task:Run normally/);
		expect(getProbe().requests).toHaveLength(1);
	});
});
