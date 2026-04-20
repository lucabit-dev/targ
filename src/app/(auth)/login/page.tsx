import { AuthForm } from "@/components/auth-form";
import { redirectIfAuthenticated } from "@/lib/auth/server";

export default async function LoginPage() {
  await redirectIfAuthenticated();

  return <AuthForm mode="login" />;
}
