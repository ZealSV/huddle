import { signJwt } from "../../lib/jwt";
import { db } from "../../lib/db";

// POST /api/auth/login
export async function login(req: { email: string; password: string }) {
  const user = await db.users.findByEmail(req.email);
  if (!user || !(await user.checkPassword(req.password))) {
    return { data: null, error: { code: "INVALID_CREDENTIALS", message: "Wrong email or password" } };
  }
  const token = signJwt({ sub: user.id }, { expiresIn: "7d" });
  return { data: { token, user: { id: user.id, email: user.email, name: user.name } }, error: null };
}
