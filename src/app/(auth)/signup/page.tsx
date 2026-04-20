import { AuthForm } from "@/components/auth-form";
import { redirectIfAuthenticated } from "@/lib/auth/server";

export default async function SignupPage() {
  await redirectIfAuthenticated();

  return <AuthForm mode="signup" />;
}
