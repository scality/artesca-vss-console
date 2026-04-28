import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";

const DEV_USER = { id: "1", name: "console-operator", email: "console@local" };

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      name: "Console password",
      credentials: {
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const password = credentials?.password as string | undefined;
        if (!password) return null;

        const envHash = process.env.CONSOLE_PASSWORD_HASH;
        const envPlain = process.env.CONSOLE_PASSWORD ?? "scality";

        if (envHash) {
          const ok = await bcrypt.compare(password, envHash);
          return ok ? DEV_USER : null;
        }

        return password === envPlain ? DEV_USER : null;
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
