import NextAuth, { type Session } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import fs from "fs/promises";
import path from "path";

const DEV_USER = { id: "1", name: "console-operator", email: "console@local" };

// In docker mode, PATCH /api/secrets/console-auth-password writes a bcrypt hash
// to this file so the password can be rotated without restarting the container.
export async function getPasswordHash(): Promise<{ hash: string; isHashed: boolean } | null> {
  const envHash = process.env.CONSOLE_PASSWORD_HASH;
  if (envHash) return { hash: envHash, isHashed: true };


  const plain = process.env.CONSOLE_PASSWORD ?? "scality";
  return { hash: plain, isHashed: false };
}

const BYPASS_SESSION: Session = {
  user: DEV_USER,
  expires: "2099-01-01T00:00:00.000Z",
};

export async function _authorize(
  password: string | undefined,
): Promise<typeof DEV_USER | null> {
  if (!password) return null;

  const stored = await getPasswordHash();
  if (!stored) return null;

  if (stored.isHashed) {
    const ok = await bcrypt.compare(password, stored.hash);
    return ok ? DEV_USER : null;
  }

  return password === stored.hash ? DEV_USER : null;
}

const {
  handlers,
  auth: _nextAuth,
  signIn,
  signOut,
} = NextAuth({
  providers: [
    Credentials({
      name: "Console password",
      credentials: {
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        return _authorize(credentials?.password as string | undefined);
      },
    }),
  ],
  session: {
    strategy: "jwt",
    maxAge: 12 * 60 * 60, // 12 hours
  },
  cookies: {
    sessionToken: {
      name: "next-auth.session-token",
      options: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
      },
    },
  },
  pages: {
    signIn: "/sign-in",
  },
});

// When CONSOLE_DISABLE_AUTH=true, the bypass must handle two call forms:
//   auth()           — session accessor in API routes → returns BYPASS_SESSION
//   auth(handler)    — middleware wrapper in proxy.ts → injects req.auth and calls handler
const auth: typeof _nextAuth = process.env.CONSOLE_DISABLE_AUTH === "true"
  ? ((callbackOrVoid?: unknown) => {
      if (typeof callbackOrVoid === "function") {
        return (req: Request) => {
          (req as unknown as Record<string, unknown>).auth = BYPASS_SESSION;
          return (callbackOrVoid as (req: Request) => unknown)(req);
        };
      }
      return Promise.resolve(BYPASS_SESSION);
    }) as unknown as typeof _nextAuth
  : _nextAuth;

export { handlers, auth, signIn, signOut };
