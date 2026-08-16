import { getSignUpUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";

import { isWorkOSEnvironmentConfigured } from "../../workos-configuration";

export async function GET() {
  const configured = isWorkOSEnvironmentConfigured(process.env);
  if (!configured) {
    return NextResponse.json({ error: "Human authentication is not configured." }, { status: 503 });
  }
  redirect(await getSignUpUrl({ returnTo: "/app" }));
}
