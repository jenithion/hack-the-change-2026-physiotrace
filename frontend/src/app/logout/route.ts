import { NextResponse } from "next/server";

export async function GET(request: Request) {
  return NextResponse.redirect(new URL("/auth/logout", request.url));
}

export async function POST(request: Request) {
  return GET(request);
}
