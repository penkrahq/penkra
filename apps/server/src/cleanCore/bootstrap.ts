// One consistent startup snapshot for navigation and running thread shells.
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { getNavigation } from "./navigation";
import { listRunningThreads } from "./threadList";

export const getBootstrap = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const navigation = yield* getNavigation;
      const runningThreads = yield* listRunningThreads();
      return { navigation, runningThreads };
    }),
  );
});
