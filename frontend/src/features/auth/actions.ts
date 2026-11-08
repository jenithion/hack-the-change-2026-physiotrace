"use server";

import { redirect } from "next/navigation";

// Auth0 Universal Login owns password collection, signup, social providers,
// email verification, MFA, password reset and account recovery.
export async function logIn() {
  redirect("/auth/login");
}

export async function signUp() {
  redirect("/auth/login?screen_hint=signup");
}

export async function googleSignIn() {
  redirect("/auth/login");
}
