import { fetchResult } from "../../cfetch";
import { performApiFetch } from "../../cfetch/internal";
import {
	createWorkerUploadForm,
	fromMimeType,
} from "../../deployment-bundle/create-worker-upload-form";
import { FatalError, UserError } from "../../errors";
import { getMetricsUsageHeaders } from "../../metrics";
import { versionsSecretListHandler, versionsSecretsListOptions } from "./list";
import { versionsSecretPutHandler, versionsSecretsPutOptions } from "./put";
import {
	versionsSecretPutBulkHandler,
	versionsSecretsPutBulkOptions,
} from "./bulk";
import type { WorkerMetadataBinding } from "../../deployment-bundle/create-worker-upload-form";
import type {
	CfModule,
	CfTailConsumer,
	CfUserLimits,
	CfWorkerInit,
} from "../../deployment-bundle/worker";
import type { CommonYargsArgv } from "../../yargs-types";
import type { File, SpecIterableIterator } from "undici";

export function registerVersionsSecretsSubcommands(yargs: CommonYargsArgv) {
	return yargs
		.command(
			"put <key>",
			"Create or update a secret variable for a Worker",
			versionsSecretsPutOptions,
			versionsSecretPutHandler
		)
		.command(
			"bulk <key>",
			"Create or update a secret variable for a Worker",
			versionsSecretsPutBulkOptions,
			versionsSecretPutBulkHandler
		)
		.command(
			"list",
			"List the secrets currently deployed",
			versionsSecretsListOptions,
			versionsSecretListHandler
		);
}

// Shared code
export interface WorkerVersion {
	id: string;
	metadata: WorkerMetadata;
	number: number;
}

export interface WorkerMetadata {
	author_email: string;
	author_id: string;
	created_on: string;
	modified_on: string;
	source: string;
}

interface Annotations {
	"workers/message"?: string;
	"workers/tag"?: string;
	"workers/triggered_by"?: string;
}

export interface VersionDetails {
	id: string;
	metadata: WorkerMetadata;
	annotations?: Annotations;
	number: number;
	resources: {
		bindings: WorkerMetadataBinding[];
		script: {
			etag: string;
			handlers: string[];
			placement_mode?: "smart";
			last_deployed_from: string;
		};
		script_runtime: {
			compatibility_date?: string;
			compatibility_flags?: string[];
			usage_model: "bundled" | "unbound" | "standard";
			limits: CfUserLimits;
		};
	};
}

interface ScriptSettings {
	logpush: boolean;
	tail_consumers: CfTailConsumer[] | null;
}

interface CopyLatestWorkerVersionArgs {
	accountId: string;
	scriptName: string;
	versionId: string;
	secrets: { name: string; value: string }[];
	versionMessage?: string;
	versionTag?: string;
	sendMetrics?: boolean;
}

// TODO: This is a naive implementation, replace later
export async function copyWorkerVersionWithNewSecrets({
	accountId,
	scriptName,
	versionId,
	secrets,
	versionMessage,
	versionTag,
	sendMetrics,
}: CopyLatestWorkerVersionArgs) {
	// Grab the specific version info
	const versionInfo = await fetchResult<VersionDetails>(
		`/accounts/${accountId}/workers/scripts/${scriptName}/versions/${versionId}`
	);

	// Naive implementation ahead, don't worry too much about it -- we will replace it
	const { mainModule, modules } = await parseModules(
		accountId,
		scriptName,
		versionId
	);

	// Grab the script settings
	const scriptSettings = await fetchResult<ScriptSettings>(
		`/accounts/${accountId}/workers/scripts/${scriptName}/script-settings`
	);

	// Filter out secrets because we're gonna inherit them
	const bindings = versionInfo.resources.bindings.filter(
		(binding) => binding.type !== "secret_text"
	);

	// Add the new secrets
	for (const secret of secrets) {
		bindings.push({
			type: "secret_text",
			name: secret.name,
			text: secret.value,
		});
	}

	const worker: CfWorkerInit = {
		name: scriptName,
		main: mainModule,
		// @ts-expect-error - everything is optional but through | undefined rather than ? so it wants an explicit undefined
		bindings: {}, // handled in rawBindings
		rawBindings: bindings,
		modules,
		compatibility_date: versionInfo.resources.script_runtime.compatibility_date,
		compatibility_flags:
			versionInfo.resources.script_runtime.compatibility_flags,
		usage_model: versionInfo.resources.script_runtime
			.usage_model as CfWorkerInit["usage_model"],
		keepVars: false, // we're re-uploading everything
		keepSecrets: true, // we need to inherit from the previous Worker Version
		logpush: scriptSettings.logpush,
		placement:
			versionInfo.resources.script.placement_mode === "smart"
				? { mode: "smart" }
				: undefined,
		tail_consumers: scriptSettings.tail_consumers ?? undefined,
		limits: versionInfo.resources.script_runtime.limits,
		annotations: {
			"workers/message": versionMessage,
			"workers/tag": versionTag,
		},
	};

	const body = createWorkerUploadForm(worker);
	const result = await fetchResult<{
		available_on_subdomain: boolean;
		id: string | null;
		etag: string | null;
		deployment_id: string | null;
	}>(
		`/accounts/${accountId}/workers/scripts/${scriptName}/versions`,
		{
			method: "POST",
			body,
			headers: await getMetricsUsageHeaders(sendMetrics),
		},
		new URLSearchParams({
			include_subdomain_availability: "true",
			// pass excludeScript so the whole body of the
			// script doesn't get included in the response
			excludeScript: "true",
		})
	);

	return result;
}

async function parseModules(
	accountId: string,
	scriptName: string,
	versionId: string
): Promise<{ mainModule: CfModule; modules: CfModule[] }> {
	// Pull the Worker content - https://developers.cloudflare.com/api/operations/worker-script-get-content
	const contentRes = await performApiFetch(
		`/accounts/${accountId}/workers/scripts/${scriptName}/content/v2?version=${versionId}`
	);
	if (
		contentRes.headers.get("content-type")?.startsWith("multipart/form-data")
	) {
		const formData = await contentRes.formData();

		// Workers Sites is not supported
		if (formData.get("__STATIC_CONTENT_MANIFEST") !== null) {
			throw new UserError(
				"Workers Sites is not supported for `versions secret put` today."
			);
		}

		// Load the main module and any additionals
		const entrypoint = contentRes.headers.get("cf-entrypoint");
		if (entrypoint === null) {
			throw new FatalError("Got modules without cf-entrypoint header");
		}

		const entrypointPart = formData.get(entrypoint) as File | null;
		if (entrypointPart === null) {
			throw new FatalError("Could not find entrypoint in form-data");
		}

		const mainModule: CfModule = {
			name: entrypointPart.name,
			filePath: "",
			content: await entrypointPart.text(),
			type: fromMimeType(entrypointPart.type),
		};

		const modules = await Promise.all(
			Array.from(formData.entries() as SpecIterableIterator<[string, File]>)
				.filter(([name, _]) => name !== entrypoint)
				.map(
					async ([name, file]) =>
						({
							name,
							filePath: "",
							content: await file.text(),
							type: fromMimeType(file.type),
						}) as CfModule
				)
		);

		return { mainModule, modules };
	} else {
		const contentType = contentRes.headers.get("content-type");
		if (contentType === null) {
			throw new FatalError(
				"No content-type header was provided for non-module Worker content"
			);
		}

		// good old Service Worker with no additional modules
		const content = await contentRes.text();

		const mainModule: CfModule = {
			name: "index.js",
			filePath: "",
			content,
			type: fromMimeType(contentType),
		};

		return { mainModule, modules: [] };
	}
}
