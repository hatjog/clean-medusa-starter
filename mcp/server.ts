import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const DEFAULT_MEDUSA_BASE_URL = "http://localhost:9002";

const MEDUSA_BASE_URL = (process.env.MCP_MEDUSA_BASE_URL || DEFAULT_MEDUSA_BASE_URL).replace(/\/$/, "");

function assertAllowedPath(scope: "admin" | "seller", path: string) {
	const normalized = path.startsWith("/") ? path : `/${path}`;

	const allowPrefixes: Record<typeof scope, string[]> = {
		admin: ["/admin/", "/auth/user/"],
		seller: ["/vendor/", "/auth/seller/"],
	};

	if (!allowPrefixes[scope].some((p) => normalized.startsWith(p))) {
		throw new Error(
			`Path not allowed for scope=${scope}. Allowed prefixes: ${allowPrefixes[scope].join(", ")}. Got: ${normalized}`
		);
	}

	return normalized;
}

function toUpperMethod(method: string): HttpMethod {
	const m = method.toUpperCase();
	if (m === "GET" || m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE") return m;
	throw new Error(`Unsupported HTTP method: ${method}`);
}

async function medusaFetch(args: {
	scope: "admin" | "seller";
	path: string;
	method: HttpMethod;
	headers?: Record<string, string>;
	body?: unknown;
}) {
	const normalizedPath = assertAllowedPath(args.scope, args.path);
	const url = `${MEDUSA_BASE_URL}${normalizedPath}`;

	const headers: Record<string, string> = { ...args.headers };

	let body: string | undefined;
	if (args.body !== undefined && args.method !== "GET") {
		if (typeof args.body === "string") {
			body = args.body;
		} else {
			body = JSON.stringify(args.body);
			headers["content-type"] = headers["content-type"] || "application/json";
		}
	}

	const res = await fetch(url, {
		method: args.method,
		headers,
		body,
	});

	const contentType = res.headers.get("content-type") || "";
	let responseBodyText = await res.text();

	const maxLen = 20_000;
	let truncated = false;
	if (responseBodyText.length > maxLen) {
		responseBodyText = responseBodyText.slice(0, maxLen);
		truncated = true;
	}

	let prettyBody = responseBodyText;
	if (contentType.includes("application/json")) {
		try {
			prettyBody = JSON.stringify(JSON.parse(responseBodyText), null, 2);
		} catch {
			// ignore
		}
	}

	const summary = {
		url,
		status: res.status,
		ok: res.ok,
		contentType,
		truncated,
	};

	return { summary, body: prettyBody };
}

const server = new McpServer({
	name: "gp-mercur-medusa-http",
	version: "0.1.0",
});

const requestInput = {
	scope: z.enum(["admin", "seller"]).describe("Which Medusa API surface to allow"),
	path: z
		.string()
		.min(1)
		.describe("Request path, must start with /admin/ or /auth/user/ for admin; /vendor/ or /auth/seller/ for seller"),
	method: z
		.string()
		.default("GET")
		.describe("HTTP method: GET|POST|PUT|PATCH|DELETE"),
	headers: z.record(z.string()).optional().describe("Extra HTTP headers"),
	body: z.any().optional().describe("Request body (object will be JSON encoded)"),
};

server.tool(
	"medusa_request",
	requestInput,
	async ({ scope, path, method, headers, body }: { scope: "admin" | "seller"; path: string; method: string; headers?: Record<string, string>; body?: unknown }) => {
		const result = await medusaFetch({
			scope,
			path,
			method: toUpperMethod(method),
			headers,
			body,
		});

		return {
			content: [
				{ type: "text", text: JSON.stringify(result.summary, null, 2) },
				{ type: "text", text: result.body },
			],
		};
	}
);

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	// eslint-disable-next-line no-console
	console.error(err);
	process.exit(1);
});
