import { describe, expect, test } from "bun:test";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createExtensionModelQuery } from "../../src/extensibility/extensions/model-api";

function model(id: string, name: string, provider: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

const claude = model("claude-opus-4-8", "Claude Opus 4.8", "anthropic");
const claudePrev = model("claude-opus-4-7", "Claude Opus 4.7", "anthropic");
const gpt = model("gpt-5.4", "GPT-5.4", "openai");
const kimi = buildModel({
	id: "moonshotai/kimi-k3",
	name: "Kimi K3 through OpenRouter",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.example.test/v1",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max] },
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
});
const qwen = buildModel({
	id: "qwen/qwen3.6-27b",
	name: "Qwen 3.6 through Together",
	api: "openai-completions",
	provider: "together",
	baseUrl: "https://together.example.test/v1",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
});

const configured = [claude, gpt, kimi, qwen] as Model<Api>[];

/** Minimal live-auth registry stub for the model facade and core resolver. */
function registry(
	authenticatedProviders = new Set(configured.map(entry => entry.provider)),
	credentialChecks: string[] = [],
): ModelRegistry {
	return {
		getAll: () => configured,
		// Configuration and credential health are deliberately independent.
		getAvailable: () => configured,
		getApiKey: async (entry: Model<Api>) => {
			credentialChecks.push(entry.provider);
			return authenticatedProviders.has(entry.provider) ? "working-key" : undefined;
		},
	} as unknown as ModelRegistry;
}

describe("createExtensionModelQuery", () => {
	test("list() and current() pass through to the registry and session model", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => gpt);
		expect(q.list()).toEqual(configured);
		expect(q.current()).toBe(gpt);
	});

	test("current() reflects the live session model, read lazily", () => {
		let active: Model<Api> | undefined = claude;
		const q = createExtensionModelQuery(registry(), undefined, () => active);
		expect(q.current()).toBe(claude);
		active = gpt;
		expect(q.current()).toBe(gpt);
	});

	test("resolve() matches model strings through the core resolver", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined);
		expect(q.resolve("anthropic/claude-opus-4-8")).toBe(claude);
		expect(q.resolve("gpt-5.4")?.provider).toBe("openai");
		expect(q.resolve("definitely-not-a-model")).toBeUndefined();
	});

	test("resolve() honors configured role aliases via the same settings-backed path as core", () => {
		const settings = {
			getModelRole: (role: string) => (role === "slow" ? "anthropic/claude-opus-4-8" : undefined),
		} as unknown as Settings;
		const q = createExtensionModelQuery(registry(), settings, () => undefined);
		expect(q.resolve("@slow")).toBe(claude);
	});

	test("family() groups a vendor's point releases and separates vendors", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined);
		expect(q.family(claude)).toBe(q.family(claudePrev));
		expect(q.family(claude)).not.toBe(q.family(gpt));
	});

	test("resolveSelection() probes working credentials and derives Moonshot for functional proxied Kimi", async () => {
		const credentialChecks: string[] = [];
		const q = createExtensionModelQuery(registry(undefined, credentialChecks), undefined, () => undefined);
		const opaqueFamily = q.family(kimi);

		const selection = await q.resolveSelection("openrouter/moonshotai/kimi-k3:max");

		expect(credentialChecks).toEqual(["openrouter"]);
		expect(selection).toMatchObject({
			model: kimi,
			provider: "openrouter",
			id: "moonshotai/kimi-k3",
			thinkingLevel: Effort.Max,
			authenticated: true,
			vendorId: "moonshot",
		});
		expect(selection?.vendorId).not.toBe(selection?.provider);
		expect(q.family(kimi)).toBe(opaqueFamily);
	});

	test("resolveSelection() reports configured Kimi nonfunctional after probing its credential", async () => {
		const credentialChecks: string[] = [];
		const authenticatedProviders = new Set(configured.map(entry => entry.provider));
		authenticatedProviders.delete("openrouter");
		const modelRegistry = registry(authenticatedProviders, credentialChecks);
		const q = createExtensionModelQuery(modelRegistry, undefined, () => undefined);
		expect(modelRegistry.getAvailable()).toContain(kimi);

		const selection = await q.resolveSelection("openrouter/moonshotai/kimi-k3:max");

		expect(credentialChecks).toEqual(["openrouter"]);
		expect(selection).toMatchObject({ model: kimi, authenticated: false, vendorId: "moonshot" });
	});

	test("resolveSelection() probes working credentials and derives Alibaba for functional proxied Qwen", async () => {
		const credentialChecks: string[] = [];
		const q = createExtensionModelQuery(registry(undefined, credentialChecks), undefined, () => undefined);
		const opaqueFamily = q.family(qwen);

		const selection = await q.resolveSelection("together/qwen/qwen3.6-27b:high");

		expect(credentialChecks).toEqual(["together"]);
		expect(selection).toMatchObject({
			model: qwen,
			provider: "together",
			id: "qwen/qwen3.6-27b",
			thinkingLevel: Effort.High,
			authenticated: true,
			vendorId: "alibaba",
		});
		expect(selection?.vendorId).not.toBe(selection?.provider);
		expect(q.family(qwen)).toBe(opaqueFamily);
	});

	test("resolveSelection() reports configured Qwen nonfunctional after probing its credential", async () => {
		const credentialChecks: string[] = [];
		const authenticatedProviders = new Set(configured.map(entry => entry.provider));
		authenticatedProviders.delete("together");
		const modelRegistry = registry(authenticatedProviders, credentialChecks);
		const q = createExtensionModelQuery(modelRegistry, undefined, () => undefined);
		expect(modelRegistry.getAvailable()).toContain(qwen);

		const selection = await q.resolveSelection("together/qwen/qwen3.6-27b:high");

		expect(credentialChecks).toEqual(["together"]);
		expect(selection).toMatchObject({ model: qwen, authenticated: false, vendorId: "alibaba" });
	});
});
