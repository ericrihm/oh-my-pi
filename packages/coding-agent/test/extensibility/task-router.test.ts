import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

type RouterMode = "null" | "complete" | "reject" | "malformed" | "partial" | "length" | "reversed" | "hang";

interface RouterProbe {
	mode: RouterMode;
	registrations: number;
	requests: Array<{ taskCwd?: string; items?: Array<Record<string, unknown>> }>;
	executions: unknown[];
	entered: boolean;
	enteredPromise: Promise<void>;
	signalEntered(): void;
	aborted: boolean;
}

declare global {
	var __ompTaskRouterProbe: RouterProbe | undefined;
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

function newProbe(mode: RouterMode = "null"): RouterProbe {
	const entered = Promise.withResolvers<void>();
	return {
		mode,
		registrations: 0,
		requests: [],
		executions: [],
		entered: false,
		enteredPromise: entered.promise,
		signalEntered: entered.resolve,
		aborted: false,
	};
}

function getProbe(): RouterProbe {
	if (!globalThis.__ompTaskRouterProbe) throw new Error("router probe was not initialized");
	return globalThis.__ompTaskRouterProbe;
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

function readField(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object" || !(key in value)) return undefined;
	return value[key];
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
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
	});

	beforeEach(() => {
		globalThis.__ompTaskRouterProbe = newProbe();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent, scoutAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			getProbe().executions.push(options);
			return resultFor(options.index ?? 0, options.agent.name, options.assignment);
		});
	});

	afterEach(async () => {
		vi.useRealTimers();
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

	async function writeRouter(id: string, apiVersion = 1): Promise<string> {
		const extensionPath = path.join(tempDir, `${id}-${crypto.randomUUID()}.ts`);
		await fs.writeFile(
			extensionPath,
			[
				"export default function (pi) {",
				"  const probe = globalThis.__ompTaskRouterProbe;",
				"  probe.registrations += 1;",
				"  pi.registerTaskRouter({",
				`    id: ${JSON.stringify(id)},`,
				`    apiVersion: ${apiVersion},`,
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
				"      if (probe.mode === 'malformed') return { decisions: 'not-an-array' };",
				"      const decisions = request.items.map((item, position) => ({",
				"        index: item.index,",
				"        strictRoute: true,",
				"        selection: item.reviewOfRouteId ? {",
				"          selector: 'openai/gpt-5.4',",
				"          provider: 'openai',",
				"          id: 'gpt-5.4',",
				"          effort: 'high',",
				"          authenticated: true,",
				"          vendorId: 'openai',",
				"        } : {",
				"          selector: 'anthropic/claude-sonnet-4-5',",
				"          provider: 'anthropic',",
				"          id: 'claude-sonnet-4-5',",
				"          effort: position === 0 ? 'low' : 'high',",
				"          authenticated: true,",
				"          vendorId: 'anthropic',",
				"        },",
				"        route: { router: 'regulus', routeId: item.reviewOfRouteId ? 'review-' + item.index : 'route-' + item.index },",
				"      }));",
				"      if (probe.mode === 'partial') return { decisions: decisions.slice(0, 1) };",
				"      if (probe.mode === 'length') return { decisions: [...decisions, decisions[0]] };",
				"      if (probe.mode === 'reversed') return { decisions: decisions.toReversed() };",
				"      return probe.mode === 'complete' ? { decisions } : null;",
				"    },",
				"  });",
				"}",
			].join("\n"),
		);
		return extensionPath;
	}

	async function createSession(extensionPaths: string[] = [], extraSettings: Record<string, unknown> = {}) {
		const created = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry,
			settings: Settings.isolated({
				"task.batch": true,
				"task.isolation.mode": "none",
				"task.prewalk": true,
				"async.enabled": true,
				...extraSettings,
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

	it("passes one initially unbound one-shot router reference through real SDK assembly", async () => {
		let deferredReference: unknown;
		const originalCreate = TaskTool.create;
		vi.spyOn(TaskTool, "create").mockImplementation(async toolSession => {
			deferredReference = readField(toolSession, "taskRouter");
			const current = readField(deferredReference, "current");
			expect(current).toBeFunction();
			if (typeof current === "function") expect(Reflect.apply(current, deferredReference, [])).toBeUndefined();
			return originalCreate.call(TaskTool, toolSession);
		});
		const extensionPath = await writeRouter("deferred-probe");
		const { tool } = await createSession([extensionPath]);

		const current = readField(deferredReference, "current");
		expect(readField(tool, "taskRouter")).toBe(deferredReference);
		expect(typeof current === "function" ? Reflect.apply(current, deferredReference, []) : undefined).toMatchObject({
			id: "deferred-probe",
		});
		const bind = readField(deferredReference, "bind");
		expect(bind).toBeFunction();
		expect(() => {
			if (typeof bind === "function") Reflect.apply(bind, deferredReference, [{ id: "second-router" }]);
		}).toThrow(/already bound/i);

		await tool.execute("same-reference", { agent: "task", task: "Use the bound router." } as never);
		expect(getProbe().requests).toHaveLength(1);
	});

	it("consumes complete ordered decisions and strips caller route fields before routing", async () => {
		globalThis.__ompTaskRouterProbe = newProbe("complete");
		const extensionPath = await writeRouter("sdk-probe");
		const { session, tool } = await createSession([extensionPath]);

		await tool.execute("invalid", { agent: "task", routeId: "hidden-before-validation" } as never);
		expect(getProbe().requests).toHaveLength(0);

		await tool.execute("batch", {
			context: "Shared repository context.",
			tasks: [
				{
					agent: "task",
					task: "Apply the mechanical edit.",
					routeId: "forged-route",
					router: "forged-router",
					provenance: { forged: true },
					unknownRouteField: "drop-me",
				},
				{ agent: "scout", task: "Map the dependency seam.", model: "forged/model" },
			],
		} as never);
		await Promise.all((session.asyncJobManager?.getAllJobs() ?? []).map(job => job.promise));

		expect(getProbe().registrations).toBe(1);
		expect(getProbe().requests).toHaveLength(1);
		expect(getProbe().requests[0]).toMatchObject({
			taskCwd: tempDir,
			items: [
				{ index: 0, agent: "task", task: "Apply the mechanical edit." },
				{ index: 1, agent: "scout", task: "Map the dependency seam." },
			],
		});
		for (const item of getProbe().requests[0]?.items ?? []) {
			for (const hidden of ["model", "routeId", "router", "provenance", "unknownRouteField"]) {
				expect(item).not.toHaveProperty(hidden);
			}
		}
		expect(
			getProbe().executions.map(execution => ({
				assignment: readField(execution, "assignment"),
				route: readField(execution, "route"),
			})),
		).toEqual([
			{
				assignment: "Apply the mechanical edit.",
				route: { router: "regulus", routeId: "route-0" },
			},
			{
				assignment: "Map the dependency seam.",
				route: { router: "regulus", routeId: "route-1" },
			},
		]);
	});

	it.each(["reject", "malformed", "partial", "length", "reversed"] as const)(
		"refuses %s routing atomically before every observable side effect",
		async mode => {
			globalThis.__ompTaskRouterProbe = newProbe(mode);
			const extensionPath = await writeRouter(`${mode}-probe`);
			const { session, tool } = await createSession([extensionPath]);
			const allocate = vi.spyOn(AgentOutputManager.prototype, "allocate");
			const registerAgent = vi.spyOn(AgentRegistry.prototype, "register");
			const registerJob = vi.spyOn(AsyncJobManager.prototype, "register");
			const provider = vi.spyOn(modelRegistry, "getApiKey");

			const result = await tool.execute(`batch-${mode}`, {
				context: "Shared.",
				tasks: [
					{ agent: "task", task: "First." },
					{ agent: "scout", task: "Second." },
				],
			} as never);

			expect(firstText(result)).toMatch(/route|routing|decision|refusal|malformed|partial|order|length/i);
			expect(getProbe().executions).toEqual([]);
			expect(allocate).not.toHaveBeenCalled();
			expect(registerAgent).not.toHaveBeenCalled();
			expect(registerJob).not.toHaveBeenCalled();
			expect(provider).not.toHaveBeenCalled();
			expect(session.asyncJobManager?.getAllJobs()).toEqual([]);
		},
	);

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

	it("rejects an unsupported router API version at startup", async () => {
		const extensionPath = await writeRouter("future-router", 2);
		const outcome = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry,
			settings: Settings.isolated(),
			preloadedExtensionPaths: [extensionPath],
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

		expect(String(outcome.error)).toMatch(/future-router.*api.*2|api.*2.*future-router/i);
	});

	it("enforces the 30-second route deadline before every observable side effect", async () => {
		globalThis.__ompTaskRouterProbe = newProbe("hang");
		const extensionPath = await writeRouter("timeout-probe");
		const { session, tool } = await createSession([extensionPath]);
		expect(getProbe().registrations).toBe(1);
		const allocate = vi.spyOn(AgentOutputManager.prototype, "allocate");
		const registerAgent = vi.spyOn(AgentRegistry.prototype, "register");
		const registerJob = vi.spyOn(AsyncJobManager.prototype, "register");
		const provider = vi.spyOn(modelRegistry, "getApiKey");
		vi.useFakeTimers();

		const execution = tool.execute("timeout", { agent: "task", task: "Wait forever." } as never);
		await getProbe().enteredPromise;
		vi.advanceTimersByTime(29_999);
		expect(getProbe().aborted).toBe(false);
		vi.advanceTimersByTime(1);
		const result = await execution;

		expect(firstText(result)).toMatch(/route.*timed out|timed out.*route/i);
		expect(getProbe().aborted).toBe(true);
		expect(getProbe().executions).toEqual([]);
		expect(allocate).not.toHaveBeenCalled();
		expect(registerAgent).not.toHaveBeenCalled();
		expect(registerJob).not.toHaveBeenCalled();
		expect(provider).not.toHaveBeenCalled();
		expect(session.asyncJobManager?.getAllJobs()).toEqual([]);
	});

	it("propagates caller abort before every observable side effect", async () => {
		globalThis.__ompTaskRouterProbe = newProbe("hang");
		const extensionPath = await writeRouter("abort-probe");
		const { session, tool } = await createSession([extensionPath]);
		expect(getProbe().registrations).toBe(1);
		const allocate = vi.spyOn(AgentOutputManager.prototype, "allocate");
		const registerAgent = vi.spyOn(AgentRegistry.prototype, "register");
		const registerJob = vi.spyOn(AsyncJobManager.prototype, "register");
		const provider = vi.spyOn(modelRegistry, "getApiKey");
		const controller = new AbortController();
		const execution = tool.execute("abort", { agent: "task", task: "Abort me." } as never, controller.signal);
		await getProbe().enteredPromise;
		controller.abort();
		const result = await execution;

		expect(firstText(result)).toMatch(/abort/i);
		expect(getProbe().aborted).toBe(true);
		expect(getProbe().executions).toEqual([]);
		expect(allocate).not.toHaveBeenCalled();
		expect(registerAgent).not.toHaveBeenCalled();
		expect(registerJob).not.toHaveBeenCalled();
		expect(provider).not.toHaveBeenCalled();
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
