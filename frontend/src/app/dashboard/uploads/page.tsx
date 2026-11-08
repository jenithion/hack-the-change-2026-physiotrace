import Link from "next/link";
import { redirect } from "next/navigation";
import { auth0 } from "@/lib/auth0";
import { Uploads } from "@/features/uploads/uploads";

export default async function UploadsPage() {
  const session = await auth0.getSession();
  if (!session?.user?.sub) redirect("/auth/login");
  return (
    <main>
      <h1>Files</h1>
      <p><Link href="/dashboard">Back</Link></p>
      <Uploads userId={session.user.sub} />
    </main>
  );
}
