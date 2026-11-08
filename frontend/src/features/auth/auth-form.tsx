import Link from "next/link";
import { googleSignIn } from "./actions";

type Props = {
  title: string;
  action: (form: FormData) => Promise<void>;
  error?: string;
  switchText: string;
  switchHref: string;
};

export function AuthForm({ title, error, switchText, switchHref }: Props) {
  return (
    <main className="auth-page panel">
      <Link className="brand" href="/">⌁ physiotrace</Link>
      <h1>{title}</h1>
      {error && <p role="alert">{error}</p>}
      <form action={googleSignIn}>
        <button className="primary" type="submit">Continue with Auth0 →</button>
      </form>
      <p>Sign in, create an account, or use a configured social identity provider through the secure Auth0 login page.</p>
      <p><Link href={switchHref}>{switchText}</Link></p>
      <p className="muted">New accounts are patients. Therapist access is assigned by a care administrator.</p>
      <Link href="/demo">Explore without an account ↗</Link>
    </main>
  );
}
