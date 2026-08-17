// 一次性登录脚本：为 openai-codex 路由获取 ChatGPT 订阅（Plus/Pro/Pro Max）的 OAuth 凭据。
// 运行方式：
//   node config-example\oauth-login-openai-codex.mjs [<runtimeRoot>]
// runtimeRoot 默认取 %LOCALAPPDATA%\Programs\DeepSeek\resources\runtime（已安装应用），
// 也可用环境变量 DSH_RUNTIME 指定（例如指向 staging\payload\runtime）。
// 凭据写入 $DSH_HOME/oauth-credentials.json（默认 ~/.dsh/oauth-credentials.json），
// 与 patch-pi-ai-oauth.mjs 注入的文件存储共用同一文件，token 到期后应用自动刷新。
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const runtimeRoot =
	process.env.DSH_RUNTIME?.trim() ||
	process.argv[2] ||
	join(process.env.LOCALAPPDATA || "", "Programs", "DeepSeek", "resources", "runtime");

const piAiModels = await import(
	pathToFileURL(join(runtimeRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "models.js")).href
);
const piAiCodex = await import(
	pathToFileURL(join(runtimeRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "openai-codex.js")).href
);
const { createModels } = piAiModels;
const { openaiCodexProvider } = piAiCodex;

// 与补丁一致的持久化存储实现（FileCredentialStore）
class FileCredentialStore {
	path;
	credentials = new Map();
	chains = new Map();
	constructor(path) {
		this.path = path;
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8"));
			for (const [providerId, credential] of Object.entries(raw)) this.credentials.set(providerId, credential);
		} catch {
			// 文件不存在或不可读：从空开始，首次写入时持久化。
		}
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

const interaction = {
	signal: new AbortController().signal,
	async prompt(req) {
		if (req?.type === "select") return "browser"; // 浏览器登录（默认）
		// manual_code 兜底提示永远挂起：浏览器回调会先完成登录流程。
		return new Promise(() => {});
	},
	async notify(n) {
		if (n?.type === "auth_url") {
			console.log("\n[登录] 请在浏览器中登录你的 ChatGPT 订阅账号（Plus / Pro / Pro Max）。");
			console.log("[登录] 授权地址（若浏览器未自动打开，请手动复制）：\n");
			console.log(n.url + "\n");
			try {
				spawn("cmd", ["/c", "start", "", n.url], { stdio: "ignore", detached: true }).unref();
			} catch {}
		} else if (n?.type === "device_code") {
			console.log(`\n[登录] 设备码: ${n.userCode}  请在 ${n.verificationUri} 输入。\n`);
		}
	},
};

console.log("[登录] 开始 OpenAI (ChatGPT) 订阅登录…… runtime: " + runtimeRoot);
try {
	const credential = await models.login("openai-codex", "oauth", interaction);
	console.log("[登录] 成功！accountId: " + credential.accountId);
	console.log("[登录] 凭据已写入: " + oauthPath());
	console.log("[登录] token 过期时间: " + new Date(credential.expires).toLocaleString() + "（应用会自动刷新）");
} catch (error) {
	console.error("[登录] 失败: " + (error instanceof Error ? error.message : String(error)));
	process.exit(1);
}
