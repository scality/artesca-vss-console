import Redis from "ioredis";
import { createLogger } from "@/lib/logger";

const log = createLogger("redis");

const globalForRedis = globalThis as unknown as { __redis?: Redis | null };

export type RedisStatus = "connected" | "disconnected";

interface RedisShape {
  status: RedisStatus;
  client: Redis | null;
}

export function getRedis(): RedisShape {
  const url = process.env.REDIS_URL;
  if (!url) {
    return { status: "disconnected", client: null };
  }

  if (!globalForRedis.__redis) {
    globalForRedis.__redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });

    globalForRedis.__redis.on("error", (err) => {
      // Log but do not crash — banner on the UI indicates disconnection.
      log.warn("connection error", { err });
    });
  }

  return { status: "connected", client: globalForRedis.__redis };
}
