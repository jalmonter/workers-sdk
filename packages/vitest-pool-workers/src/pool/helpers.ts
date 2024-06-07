import os from "node:os";
import path from "node:path";
import type { WorkspaceProject } from "vitest/node";

// User worker names must not start with this
export const WORKER_NAME_PREFIX = "vitest-pool-workers-";

export function isFileNotFoundError(e: unknown): boolean {
	return (
		typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT"
	);
}

export function getProjectPath(project: WorkspaceProject): string | number {
	return project.config.config ?? project.path;
}

export function getRelativeProjectPath(
	project: WorkspaceProject
): string | number {
	const projectPath = getProjectPath(project);
	if (typeof projectPath === "number") {
		return projectPath;
	} else {
		return path.relative("", projectPath);
	}
}

export function calculateAvailableThreads() {
	return os.availableParallelism ? os.availableParallelism() : os.cpus().length;
}

export class ThreadPool {
	#maxThreads: number;
	#activeThreads = 0;
	#queue = [] as ((value: unknown) => void)[];
	constructor(maxThreads: number) {
		this.#maxThreads = maxThreads;
		this.#activeThreads = 0;
		this.#queue = [];
	}

	async nextAvailableThread() {
		if (this.#activeThreads < this.#maxThreads) {
			this.#activeThreads++;
			return;
		}
		return new Promise((resolve) => {
			this.#queue.push(resolve);
		});
	}

	releaseThread() {
		if (this.#queue.length > 0) {
			const next = this.#queue.shift();
			next?.(undefined);
		} else {
			this.#activeThreads--;
		}
	}
}
