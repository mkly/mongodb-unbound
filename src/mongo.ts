import { MongoClient, type Db } from "mongodb";

import type { ConnectionConfig } from "./config.ts";

export interface MongoConnection {
  client: MongoClient;
  db: Db;
}

export async function withMongoConnection<T>(
  config: ConnectionConfig,
  callback: (connection: MongoConnection) => Promise<T>,
): Promise<T> {
  const client = new MongoClient(config.uri);

  try {
    await client.connect();
    return await callback({ client, db: client.db(config.db) });
  } finally {
    await client.close();
  }
}
