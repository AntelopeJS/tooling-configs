# Run a DMS from a git worktree

`antelopejs-lease` lets many agents run a DMS on one machine at the same time, each from its own git worktree of any AntelopeJS repository. Each worktree gets its own ports, its own mongod and database, its own log files, and its own tmp directory.

A lease belongs to one worktree. It keeps the same ports, mongod and data for every command you run in that worktree, until you run `antelopejs-lease down` or delete the worktree. The tool runs no daemon and needs no root.

## Start, check and stop a DMS

Run each command from inside your worktree. Each step is one shell command, and no variable carries over from one step to the next. The examples start the dms playground. In another repository, set `DMS_BACK_DIR` to its backend project.

1. Check what already runs on the machine.

   ```sh
   pnpm exec antelopejs-lease status
   ```

   `status` prints one line per lease with its id, state, api, web and mongo ports, the pid of its mongod, and its worktree. The MONGOD column shows `external` only when the lease last ran with `DMS_MONGO_URL` and no mongod of its own runs. It prints nothing when there is no lease. Pass `--json` to read it from a tool. A lease whose worktree this user cannot read, for example under a directory with mode 000, shows `unreadable:<error code>` and is kept: only a worktree whose path is gone, or that holds a new checkout, counts as deleted. If a line names your worktree, its DMS may still run. Check it with `dms-dev.sh status`, as in step 4, before you start a second one.

2. Start the DMS through `run --`.

   ```sh
   DMS_BACK_DIR=$PWD/packages/dms/playground pnpm exec antelopejs-lease run -- bash packages/dms/skills/dms-project/scripts/dms-dev.sh start
   ```

   `run` opens the lease of the worktree, starts its mongod if none runs, and runs the command after `--` with the lease variables. The ports, the Mongo URL and the log files come from the lease. Do not set `PORT`, `MONGO_URL` or a log path yourself. `run` prints nothing of its own, then hands its process over to the command, which keeps the pid of `run` and its exit code. A Ctrl-C, a kill of the process group or a `kill` of that pid reaches the command once. A second `run` in the same worktree gets the same ports, mongod and data.

   `dms-dev.sh` gives each server its own port once it reads `DMS_BACK_PORT` and `DMS_FRONT_PORT`, a change that lands in the dms repository. Until then, each server falls back to its own default port.

   In a repository without `dms-dev.sh`, start each server with `--as`. It sets `PORT` to the port of that server. Each command runs in the foreground until its server stops.

   ```sh
   pnpm exec antelopejs-lease run --as api -- ajs project dev -p playground
   pnpm exec antelopejs-lease run --as web -- ajs dms dev
   ```

3. Find your URLs.

   The backend URL is the one the backend records in `<project>/.antelope/dev.json` when it starts. `dms-dev.sh start` prints the same URL on its `backend ready on` line. The dashboard URL is `DMS_CLIENT_BASE_URL`:

   ```sh
   pnpm exec antelopejs-lease run -- printenv DMS_CLIENT_BASE_URL
   ```

   The backend binds the leased api port, `DMS_BACK_PORT`, only when its `antelope.config.ts` reads `PORT`. Most DMS repositories hard-code port 5010 there instead. Their worktrees still start side by side, because a backend whose port is taken falls back to the next free port and records it in `dev.json`. `ajs dms dev` finds the backend through that file, so `run` never sets `DMS_API_BASE_URL`. The API and WEB columns of `status` show the leased ports, not the port a fallback picked.

4. Verify through the same prefix, so that your checks reach the servers, the database and the logs of this worktree.

   ```sh
   DMS_BACK_DIR=$PWD/packages/dms/playground pnpm exec antelopejs-lease run -- bash packages/dms/skills/dms-project/scripts/dms-dev.sh status
   DMS_BACK_DIR=$PWD/packages/dms/playground pnpm exec antelopejs-lease run -- bash packages/dms/skills/dms-project/scripts/dms-dev.sh back-log 100
   ```

   Run tests the same way, for example `pnpm exec antelopejs-lease run -- pnpm test`, so that they use the mongod of the lease.

5. Stop the servers. The lease keeps its ports and its data.

   ```sh
   DMS_BACK_DIR=$PWD/packages/dms/playground pnpm exec antelopejs-lease run -- bash packages/dms/skills/dms-project/scripts/dms-dev.sh stop
   ```

   Stop your own work only through the lease, with this command or with `down --stop` in step 6. Never use `pkill`, `killall` or any pattern match on a command line, a container name or a path: the machine runs the work of many agents, and a pattern stops theirs too.

6. Tear down the lease.

   ```sh
   pnpm exec antelopejs-lease down --stop
   ```

   `down --stop` first stops the processes this worktree started, and nothing else. `run` exports `ANTELOPEJS_LEASE=<lease id>` to its command, and every process that command starts inherits it, a dev server that daemonized into another process group or session included. `down --stop` reads the environment of each process of this user in `/proc` and stops every one that holds `ANTELOPEJS_LEASE` with this lease's id, except itself and the commands that started it. It signals each pid alone, never a process group, so a process that left the lease's environment is never reached through its group. It sends SIGTERM, waits 5 s, then sends SIGKILL, and prints one `stopped pid <pid> (<command line>)` line per process. It scans again afterwards and stops what was started in the meantime. It prints nothing when there was nothing to stop. It reads the start time of each process when it finds it and checks it again before each signal, so a pid the system handed to another process in between is never signalled. A process that exited but that its parent has not reaped yet counts as stopped.

   A process that listens on the api or web port without this lease's `ANTELOPEJS_LEASE` is not this lease's, even on its port: another user's lease, another registry that handed out the same port, or an unrelated server. `down --stop` leaves it running and fails, naming its pid. A process that cleared or rewrote its environment, as `env -i` or a supervisor with a fixed environment does, no longer holds the marker, and `down --stop` cannot find it. Stop it with its own stop command.

   `antelopejs-verify` runs its setup commands, journeys, formal checks and their behaviour probes without the lease's variables, `ANTELOPEJS_LEASE` included, so `down --stop` does not reach them.

   `down --stop` reads `/proc`, so it runs on Linux only. On macOS, `ps` shows the environment of a process only appended to its command line, with no boundary between the two, so `down --stop` refuses there. Stop your servers with their own stop command, as in step 5, then run `down`.

   `down` then stops the mongod of the lease and deletes its data, logs and tmp directory. Without `--stop` it refuses while the api or web port still listens, and says to use `--stop`. `--force` skips that check. When the worktree has no lease, `down` does nothing.

7. Reclaim what other runs left behind.

   ```sh
   pnpm exec antelopejs-lease gc
   ```

   `gc` removes the leases of deleted worktrees, the lease directories that a crash left without a record, and the leases that had no running `run`, no mongod and no listening port for 14 days. `--idle <days>` changes that age. It takes 1 or more days, so a lease that a `run` opened within the last day is never idle, and neither is a lease whose `run` still runs. `run` and `status` already remove the leases of deleted worktrees, so `gc` matters after a crash or when the disk fills up.

## Variables that `run` sets

`run` passes its own environment to the command without `PORT`, and adds these variables. It does not set `DMS_API_BASE_URL`, because `ajs dms dev` would read it before `.antelope/dev.json` and miss a backend that fell back to another port.

| Variable                         | Value                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ANTELOPEJS_LEASE`               | The lease id, the first ten hex digits of the sha256 of the worktree path. `down --stop` stops the processes that hold it  |
| `ANTELOPEJS_LEASE_DIR`           | The lease directory                                                                                                        |
| `ANTELOPEJS_LEASE_PARENT_TMPDIR` | The `TMPDIR` the caller had, empty when it had none. `antelopejs-verify` keeps its runs there and hands it to its journeys |
| `DMS_BACK_PORT`                  | The api port                                                                                                               |
| `DMS_FRONT_PORT`                 | The web port                                                                                                               |
| `DMS_INSPECT_PORT`               | The Node inspector port                                                                                                    |
| `DMS_SMTP_PORT`                  | The SMTP port                                                                                                              |
| `DMS_CLIENT_BASE_URL`            | `http://localhost:<web port>`                                                                                              |
| `MONGO_URL`                      | `mongodb://127.0.0.1:<mongo port>`, or `DMS_MONGO_URL` when it is set                                                      |
| `MONGO_DATABASE`                 | `dms_<lease id>`                                                                                                           |
| `DMS_BACK_LOG`                   | `<lease dir>/logs/back.log`                                                                                                |
| `DMS_FRONT_LOG`                  | `<lease dir>/logs/front.log`                                                                                               |
| `TMPDIR`                         | `<lease dir>/tmp`                                                                                                          |
| `PORT`                           | Removed. With `--as api` or `--as web`, the api or web port                                                                |

To use a Mongo server you run yourself, set `DMS_MONGO_URL` before `run`. `run` then starts no mongod, and `MONGO_DATABASE` still gives each worktree its own database on that server. A mongod the lease started before keeps running for the servers that still use it, and `status` shows its pid. `down` stops it.

The lease directory is `~/.antelopejs/leases/<lease id>/`. It holds `lease.json`, the mongod data in `mongo/`, the logs in `logs/` with `mongod.log` beside the two server logs, `tmp/`, and `runs/` with one empty file per `run`, named by its pid, that `gc` reads to keep the lease of a running command.

## Why the ports sit between 20010 and 29999

Each lease owns a block of ten ports in the band from 20010 to 29999. The offset of a port in its block gives its role:

- Offset 0 is the api.
- Offset 1 is the web dashboard.
- Offset 2 is mongod.
- Offset 3 is SMTP.
- Offset 4 is the Node inspector.
- Offset 5 is the Vite HMR port.
- Offsets 6 to 9 stay free for later roles.

The kernel picks ephemeral ports from 32768 to 60999 on Linux and from 49152 up on macOS. It hands out such a port to every `bind` on port 0 and to every outgoing connection. Another process can take a port in that range between the moment a tool picks it and the moment a server binds it. That race is what makes tools that bind port 0, such as dms-control, collide under load. No process gets a port below 32768 unless it asks for that number, so the band avoids the race.

The first block a lease tries comes from its id and your user id, so two worktrees rarely start on the same block, and a worktree usually gets its old block back after `down`. The tool skips a block that holds 24678, the Vite HMR default, or 27017 to 27019, where a system mongod listens. It also skips a block when any of its ten ports fails to bind, and it stores the ports it chose in `lease.json`. A foreign listener moves a lease only when the lease is first created. Every later `run` keeps the recorded ports, so the servers, the database and the URLs of a worktree stay where they were. If another process takes the mongo port of the lease in the meantime, `run` fails and names that process rather than moving the lease.

A lock on 127.0.0.1:20000 keeps two callers from choosing at the same moment. A caller listens on that port while it reads and writes the registry, and the kernel closes the port when the caller exits, after a crash too. No stale lock can remain.

## Leases are coordinated per user

Each user has one registry, `~/.antelopejs/leases`, and every command reads and writes only that one. The lock on 127.0.0.1:20000 is machine-wide, but the records are not. A lease never sees the leases of another user, nor those of a registry that `ANTELOPEJS_LEASE_HOME` moves to another absolute path. That variable exists for the tests. Leave it unset for real work.

Two things still keep registries apart. The first block a lease tries comes from a hash of the lease id and the numeric user id together, so the worktrees of two users at the same path usually start on different blocks. When they start on the same one, the bind probe still separates them once a port of that block is held: it skips every block in which a process of any user holds a port when the lease is created. Once the mongod of a lease runs, it holds the mongo port, so no other registry gets that block. The probe cannot see a block that another registry chose and whose ports nothing holds yet, as with a lease that uses `DMS_MONGO_URL` before its servers start. Two registries can hand out that block twice, and the server that binds second falls back to another port or fails.

## What stays shared on purpose

`~/.antelopejs` keeps the git module cache, its lock file, and the config for every worktree. The cache holds the same modules for all of them, and its lock file already orders its writes, so one copy saves disk and download time. The lease registry sits under `~/.antelopejs/leases` so that one registry serves every repository of the user. The mongod binaries in `~/.cache/mongodb-binaries` are shared too, but each lease runs its own mongod process on its own data directory.

## Fix an error

`antelopejs-lease` prints each failure as one line on stderr, prefixed with `antelopejs-lease:`, and exits with code 1. The command after `--` keeps its own exit code. A command that is not found exits with 127, and one that is not executable with 126.

| The message says                                                   | What to do                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<dir> is not inside a git worktree`                               | Run the command from inside the worktree.                                                                                                                                                                                                                                                            |
| `registry lock 127.0.0.1:20000 held for 15 s`                      | Another process holds the lock. Find it with the `ss` or `lsof` command the message prints. Stop it if it hangs, then retry.                                                                                                                                                                         |
| `no free port block in 20010-29999`                                | Run `antelopejs-lease gc`. Run `down` in the worktrees whose leases `status` lists and you no longer need. Then retry.                                                                                                                                                                               |
| `the lease of <path> belongs to an earlier checkout`               | The servers of a deleted or recreated worktree at this path still listen. Stop the pids the message names, then rerun.                                                                                                                                                                               |
| `<dir>/lease.json was written by another antelopejs-lease version` | Run the tooling-configs version that wrote it. Or delete the directory once no DMS uses it.                                                                                                                                                                                                          |
| `no mongod on PATH or in ~/.cache/mongodb-binaries`                | Install MongoDB, or set `DMS_MONGO_URL` to a server you run.                                                                                                                                                                                                                                         |
| `mongod did not answer on port <port>`                             | Read the end of the log the message names. It says why mongod stopped. When the message names a pid that holds the port, that process took the port after the lease was created. Stop it and rerun, or run `down` so that the next `run` picks a new block.                                          |
| `mongod <pid> was still running 2 s after SIGKILL`                 | Check the process with `ps -p <pid>`. Retry once it is gone.                                                                                                                                                                                                                                         |
| `port <port> of this lease still listens`                          | Run `antelopejs-lease down --stop`, which stops what this worktree started. Never `pkill` or `killall`. With `after --stop` in the message, the pid it names lacks this lease's `ANTELOPEJS_LEASE`, so it is not yours to stop: leave it to whoever started it. To tear down anyway, pass `--force`. |
| `down --stop reads /proc and runs on Linux only`                   | Stop your servers with their own stop command, then run `antelopejs-lease down`.                                                                                                                                                                                                                     |
| `cannot run <command>`                                             | With `not found` (127), check the name and your `PATH`. With `is not executable` or `is a directory` (126), set the execute bit or name the file. With `interpreter "<path>" not found` (127), fix the `#!` line. A `\r` in it means Windows line endings.                                           |
| `ANTELOPEJS_LEASE_HOME must be an absolute path`                   | Set it to an absolute path, or unset it to use `~/.antelopejs/leases`.                                                                                                                                                                                                                               |
| Any message followed by a `usage:` line                            | Fix the arguments. The `usage:` line lists the valid forms.                                                                                                                                                                                                                                          |
