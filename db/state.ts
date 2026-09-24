import { env } from "cloudflare:workers";
export function getStateDb(){if(!env.DB)throw new Error("DB binding unavailable");return env.DB;}

