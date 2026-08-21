import { PasswordAuthForm } from "../auth-form";
import {
  AuthConfigurationUnavailable,
  convexAuthIsConfigured,
} from "../../auth-configuration-state";

export default function SignUpPage() {
  if (!convexAuthIsConfigured()) return <AuthConfigurationUnavailable />;
  return <PasswordAuthForm mode="sign-up" />;
}
