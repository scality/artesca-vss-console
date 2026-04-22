import Redis from "ioredis";

let _redis: Redis | null = null;

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

  if (!_redis) {
    _redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });

    _redis.on("error", (err) => {
      // Log but do not crash — banner on the UI indicates disconnection.
      console.warn("[redis] connection error:", err.message);
    });
  }

  return { status: "connected", client: _redis };
}
