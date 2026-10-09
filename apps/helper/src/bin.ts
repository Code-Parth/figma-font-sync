// The entry point compiled binaries are built from. main.ts only runs itself when import.meta.main is true,
// so tests can import it. In the compiled Windows binary it was false (a one-file program still reports
// true there), and every command exited 0 having done nothing.
import { runCli } from "./main";

await runCli();
