import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getModelMarket } from "@/repository/model-market";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession({ allowReadOnlyAccess: true });
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = await getModelMarket();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Failed to load model market:", error);
    return NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500 });
  }
}
