// The entry of the cloud-cache CLI.
import { main } from './cli/main';

const code = await main(process.argv.slice(2));
// Exit explicitly, as the action entries do: an open socket must not keep the CLI alive.
process.exit(code);
