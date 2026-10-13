import { describe } from "bun:test";
import { isolatedNativeFetchIt } from "./isolated-native-fetch";

const fixtureIt = isolatedNativeFetchIt(
  "src/__tests__/helpers/isolated-native-fetch-child-fixture.ts",
  "isolated native-fetch child fixture",
);

if (process.env.AITRPG_NATIVE_FETCH_TEST_FIXTURE === "hang") {
  describe("isolated native-fetch child fixture", () => {
    fixtureIt("reports ready before it hangs", async () => {
      await new Promise<void>(() => undefined);
    });
  });
}
