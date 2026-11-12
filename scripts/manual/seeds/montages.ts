import { get, type Project, post, type Token } from "./common.ts";

async function waitMontage(token: Token, projectId: string, montageId: string): Promise<void> {
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    const montage = await get<{ status: string; error: string | null }>(
      `/v1/projects/${projectId}/montages/${montageId}`,
      token,
    );
    if (montage.status === "done") return;
    if (montage.status === "failed") {
      console.log(`test seed: montage ${montageId} failed — ${montage.error ?? "no reason"}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.log(`test seed: montage ${montageId} is still processing`);
}

export async function seedMontages(
  token: Token,
  project: Project,
  projectId: string,
  itemIds: string[],
): Promise<void> {
  for (const order of project.montages) {
    const include = order.include ? order.include.flatMap((at) => itemIds[at] ?? []) : itemIds;
    const made = await post<{ id: string }>(`/v1/projects/${projectId}/montages`, token, {
      payFrom: "user",
      config: {
        targetSeconds: order.targetSeconds,
        prompt: order.prompt,
        dimensions: order.dimensions,
        musicIds: [],
        includeItemIds: include,
      },
    });
    await waitMontage(token, projectId, made.id);
  }
}
