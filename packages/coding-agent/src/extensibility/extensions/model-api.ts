/**
 * Model query facade exposed to extensions as `ctx.models`.
 *
 * Read-only: lets an extension select a model the same way core does — list
 * authenticated models, read the session model, resolve a model string or role
 * alias, and compare model families — without touching the mutable registry or
 * duplicating resolution/family heuristics.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { modelFamilyToken, stableModelVendorId } from "@oh-my-pi/pi-catalog/identity";
import type { ModelRegistry } from "../../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import type { ExtensionModelQuery } from "./types";

/**
 * Build the `ctx.models` facade. `getModel` is read lazily so `current()` always
 * reflects the live session model (it can change mid-session via `/model`).
 */
export function createExtensionModelQuery(
	modelRegistry: ModelRegistry,
	settings: Settings | undefined,
	getModel: () => Model | undefined,
): ExtensionModelQuery {
	const resolve = (spec: string) =>
		resolveModelRoleValue(spec, modelRegistry.getAvailable(), {
			settings,
			matchPreferences: getModelMatchPreferences(settings),
		});
	return {
		list: () => modelRegistry.getAvailable(),
		current: () => getModel(),
		// resolveModelRoleValue expands a role alias (`@slow`) to its full configured
		// priority list and tries each pattern — the same path core selection uses.
		resolve: (spec: string): Model<Api> | undefined => resolve(spec).model,
		family: (model: Model<Api>): string => modelFamilyToken(model.id) || model.provider.toLowerCase(),
		resolveSelection: async spec => {
			const resolved = resolve(spec);
			if (!resolved.model) return undefined;
			const model = resolved.model;
			const apiKey = await modelRegistry.getApiKey(model);
			return {
				model,
				provider: model.provider,
				id: model.id,
				...(typeof resolved.thinkingLevel === "string" && resolved.thinkingLevel !== "auto"
					? { thinkingLevel: resolved.thinkingLevel }
					: {}),
				authenticated: apiKey !== undefined,
				vendorId: stableModelVendorId(model.id, model.provider),
			};
		},
	};
}
