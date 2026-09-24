import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getStateDb } from "@/db/state";
import { stateSchema, dayState, today } from "@/lib/balance";
import { generatePlan } from "@/lib/planner";
import { z } from "zod";

export const dynamic = "force-dynamic";
const inputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  availableMinutes: z.number().int().min(0).max(1440).optional(),
  energy: z.enum(["low", "medium", "high"]).optional(),
}).strict();
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "authentication_required" }, 401);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return json({ error: "origin_not_allowed" }, 403);
  let input;
  try {
    const body = await request.text();
    if (body.length > 4096) return json({ error: "request_too_large" }, 413);
    input = inputSchema.parse(JSON.parse(body || "{}"));
    if (input.date && (!Number.isFinite(Date.parse(input.date + "T12:00:00Z")) ||
      new Date(input.date + "T12:00:00Z").toISOString().slice(0, 10) !== input.date))
      return json({ error: "invalid_date" }, 400);
  } catch { return json({ error: "invalid_request" }, 400); }
  try {
    const row = await getStateDb().prepare(
      "SELECT payload, revision FROM balance_state WHERE user_id = ?"
    ).bind(user.userId).first<{ payload: string; revision: number }>();
    if (!row) return json({ error: "setup_required", message: "请先在页面建立我的一周。" }, 409);
    const state = stateSchema.parse(JSON.parse(row.payload));
    const date = input.date ?? today();
    const day = { ...dayState(state, date) };
    if (input.availableMinutes !== undefined) day.free = Math.min(1440, day.spent + input.availableMinutes);
    if (input.energy !== undefined) day.energy = input.energy;
    state.days[date] = day;
    return json({ ...await generatePlan(state, date), revision: row.revision, persisted: false });
  } catch (error) {
    console.error("plan generation failed", error);
    return json({ error: "temporarily_unavailable" }, 503);
  }
}
