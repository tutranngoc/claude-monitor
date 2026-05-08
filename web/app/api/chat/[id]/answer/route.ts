import { NextResponse } from "next/server";
import {
  cancelAskUserQuestion,
  resolveAskUserQuestion,
} from "@/lib/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

type Body =
  | { request_id: string; answers: Record<string, string>; cancel?: never }
  | { request_id: string; cancel: true; message?: string; answers?: never };

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.request_id) {
    return NextResponse.json(
      { error: "request_id is required" },
      { status: 400 },
    );
  }
  try {
    if (body.cancel) {
      cancelAskUserQuestion(id, body.request_id, body.message ?? "");
    } else {
      if (!body.answers || typeof body.answers !== "object") {
        return NextResponse.json(
          { error: "answers must be an object" },
          { status: 400 },
        );
      }
      resolveAskUserQuestion(id, body.request_id, body.answers);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 422 },
    );
  }
}
