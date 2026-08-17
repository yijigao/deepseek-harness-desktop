// 验证 openai-codex 凭据可用：直接用 ChatGPT 订阅的 OAuth 凭据
// 经 chatgpt.com/backend-api 调一次模型，验证 auth + 自动刷新逻辑。
// 运行方式：node config-example\test-openai-codex.mjs [<modelId>] [<runtimeRoot>]
//   modelId 默认 gpt-5.6-luna；runtimeRoot 同登录脚本（默认已安装应用运行时）。
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const modelId = process.argv[2] || "gpt-5.6-luna";
const runtimeRoot =
	process.env.DSH_RUNTIME?.trim() ||
	process.argv[3] ||
	join(process.env.LOCALAPPDATA || "", "Programs", "DeepSeek", "resources", "runtime");

const piAiModels = await import(
	pathToFileURL(join(runtimeRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "models.js")).href
);
const piAiCodex = await import(
	pathToFileURL(join(runtimeRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "openai-codex.js")).href
);
const { createModels } = piAiModels;
const { openaiCodexProvider } = piAiCodex;

class FileCredentialStore {
	path;
	credentials = new Map();
	chains = new Map();
	constructor(path) {
		this.path = path;
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8"));
			for (const [providerId, credential] of Object.entries(raw)) this.credentials.set(providerId, credential);
		} catch {}
	}
	enqueue(providerId, task) {
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const next = (async () => {
			await previous.catch(() => {});
			return task();
		})();
		this.chains.set(providerId, next.catch(() => {}));
		return next;
	}
	persist() {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.credentials), null, 2));
	}
	async read(providerId) {
		return this.credentials.get(providerId);
	}
	async list() {
		return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}
	modify(providerId, fn) {
		return this.enqueue(providerId, async () => {
			const current = this.credentials.get(providerId);
			const next = await fn(current);
			if (next !== void 0) this.credentials.set(providerId, next);
			this.persist();
			return next ?? current;
		});
	}
	delete(providerId) {
		return this.enqueue(providerId, async () => {
			this.credentials.delete(providerId);
			this.persist();
		});
	}
}

function oauthPath() {
	const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
	return join(home, "oauth-credentials.json");
}

const store = new FileCredentialStore(oauthPath());
const models = createModels({ credentials: store });
models.setProvider(openaiCodexProvider());
const model = models.getModel("openai-codex", modelId);
if (!model) {
	console.error("未找到模型: " + modelId);
	process.exit(2);
}
console.log(`[验证] 使用模型 ${model.provider}/${model.id} 发送一条消息……`);
try {
	const msg = await models.completeSimple(model, {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Reply with exactly one short sentence: which model are you?" }],
	});
	const text = (msg.content || []).map((b) => b.type === "text" ? b.text : "").join(" ");
	console.log("[验证] 成功。回复: " + text.slice(0, 300));
	console.log("[验证] stopReason: " + msg.stopReason + ", tokens: " + (msg.usage?.totalTokens ?? "?"));
} catch (error) {
	console.error("[验证] 失败: " + (error instanceof Error ? error.message : String(error)));
	process.exit(1);
}
