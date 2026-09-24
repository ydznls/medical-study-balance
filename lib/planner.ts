import { recommend, type State } from "./balance";

// Integration point: replace or enrich this function with a server-side provider.
// Keep hard constraints and user confirmation for writes outside model output.
export async function generatePlan(state: State, date: string) {
  return { apiVersion: "1", engine: "rules" as const, date, ...recommend(state, date) };
}
