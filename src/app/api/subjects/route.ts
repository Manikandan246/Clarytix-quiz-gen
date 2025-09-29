import { NextRequest, NextResponse } from "next/server";
import { getDbPool } from "@/lib/db";

export const runtime = "nodejs";

interface SubjectRow {
  id: number;
  name: string;
}

export async function GET(request: NextRequest) {
  const classParam = request.nextUrl.searchParams.get("class");

  try {
    const pool = getDbPool();
    const result = await pool.query<SubjectRow>(
      `SELECT id, name
       FROM subjects
       WHERE id >= 10
       ORDER BY name`,
    );

    const subjects = result.rows
      .filter((row) => typeof row.name === "string" && row.name.length > 0)
      .map((row) => ({
        id: row.id,
        name: row.name,
      }));

    if (classParam) {
      console.log(`[subjects] Returning ${subjects.length} subjects for class ${classParam}.`);
    } else {
      console.log(`[subjects] Returning ${subjects.length} subjects (no class filter applied).`);
    }

    return NextResponse.json({ subjects });
  } catch (error) {
    console.error("[subjects] Failed to fetch subjects", error);
    return NextResponse.json(
      { error: "Unable to fetch subjects from the database." },
      { status: 500 },
    );
  }
}
