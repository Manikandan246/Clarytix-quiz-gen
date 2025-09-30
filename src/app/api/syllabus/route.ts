import { NextResponse } from "next/server";
import { getDbPool } from "@/lib/db";

export const runtime = "nodejs";

interface SyllabusRow {
  id: number;
  name: string;
}

export async function GET() {
  try {
    const pool = getDbPool();
    const result = await pool.query<SyllabusRow>(
      `SELECT id, name FROM syllabus ORDER BY name`,
    );

    return NextResponse.json({ syllabuses: result.rows });
  } catch (error) {
    console.error("[syllabus] Failed to fetch syllabuses", error);
    return NextResponse.json(
      { error: "Unable to fetch syllabuses." },
      { status: 500 },
    );
  }
}
