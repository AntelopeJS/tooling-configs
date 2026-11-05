# Run a DMS from a git worktree

`antelopejs-lease` lets many agents run a DMS on one machine at the same time, each from its own git worktree of any AntelopeJS repository. Each worktree gets its own ports, its own mongod and database, its own log files, and its own tmp directory.

A lease belongs to one worktree. It keeps the same ports, mongod and data for every command you run in that worktree, until you run `antelopejs-lease down` or delete the worktree. The tool runs no daemon and needs no root.

## Start, check and stop a DMS

Run each command from inside your worktree. Each step is one shell command, and no variable carries over from one step to the next. The examples start the dms playground. In another repository, set `DMS_BACK_DIR` to its backend project.

1. Check what already runs on the machine.

   ```sh
   pnpm exec antelopejs-lease status
   ```

   `status` prints one line per lease with its id, state, api, web and mongo ports, the pid of its mongod, and its worktree. It prints nothing when there is no lease. Pass `--json` to read it from a tool. If a line names your worktree, its DMS may still run. Check it with `dms-dev.sh status`, as in step 4, before you start a second one.

2. Start the DMS through `run --`.

   ```sh
   DMS_BACK_DIR=$PWD/packages/dms/playground pnpm exec antelopejs-lease run -- bash packages/dms/skills/dms-project/scripts/dms-dev.sh start
   ```

   `run` opens the lease of the worktree, starts its mongod if none runs, and runs the command after `--` with the lease variables. The ports, the Mongo URL and the log files come from the lease. Do not set `PORT`, `MONGO_URL` or a log path yourself. `run` prints nothing of its own and exits with the exit code of the command. A second `run` in the same worktree gets the same ports, mongod and data.

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

6. Tear down the lease.

   ```sh
   pnpm exec antelopejs-lease down
   ```

   `down` stops the mongod of the lease, then deletes its data, logs and tmp directory. It refuses while the api or web port still listens, so stop the servers first. `--force` skips that check. When the worktree has no lease, `down` does nothing.

7. Reclaim what other runs left behind.

   ```sh
   pnpm exec antelopejs-lease gc
   ```

   `gc` removes the leases of deleted worktrees, the lease directories that a crash left without a record, and the leases that had no mongod and no listening port for 14 days. `--idle <days>` changes that age. `run` and `status` already remove the leases of deleted worktrees, so `gc` matters after a crash or when the disk fills up.

## Variables that `run` sets

`run` passes its own environment to the command without `PORT`, and adds these variables. It does not set `DMS_API_BASE_URL`, because `ajs dms dev` would read it before `.antelope/dev.json` and miss a backend that fell back to another port.

| Variable               | Value                                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| `ANTELOPEJS_LEASE`     | The lease id, the first ten hex digits of the sha256 of the worktree path |
| `ANTELOPEJS_LEASE_DIR` | The lease directory                                                       |
| `DMS_BACK_PORT`        | The api port                                                              |
| `DMS_FRONT_PORT`       | The web port                                                              |
| `DMS_INSPECT_PORT`     | The Node inspector port                                                   |
| `DMS_SMTP_PORT`        | The SMTP port                                                             |
| `DMS_CLIENT_BASE_URL`  | `http://localhost:<web port>`                                             |
| `MONGO_URL`            | `mongodb://127.0.0.1:<mongo port>`, or `DMS_MONGO_URL` when it is set     |
| `MONGO_DATABASE`       | `dms_<lease id>`                                                          |
| `DMS_BACK_LOG`         | `<lease dir>/logs/back.log`                                               |
| `DMS_FRONT_LOG`        | `<lease dir>/logs/front.log`                                              |
| `TMPDIR`               | `<lease dir>/tmp`                                                         |
| `PORT`                 | Removed. With `--as api` or `--as web`, the api or web port               |

To use a Mongo server you run yourself, set `DMS_MONGO_URL` before `run`. `run` then starts no mongod, and `MONGO_DATABASE` still gives each worktree its own database on that server.

The lease directory is `~/.antelopejs/leases/<lease id>/`. It holds `lease.json`, the mongod data in `mongo/`, the logs in `logs/` with `mongod.log` beside the two server logs, and `tmp/`. The tests set `ANTELOPEJS_LEASE_HOME` to move the whole registry.

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

The first block a lease tries comes from its id, so two worktrees rarely start on the same block, and a worktree usually gets its old block back after `down`. The tool skips a block that holds 24678, the Vite HMR default, or 27017 to 27019, where a system mongod listens. It also skips a block when any of its ten ports fails to bind, and it stores the ports it chose in `lease.json`.

A lock on 127.0.0.1:20000 keeps two callers from choosing at the same moment. A caller listens on that port while it reads and writes the registry, and the kernel closes the port when the caller exits, after a crash too. No stale lock can remain.

## What stays shared on purpose

`~/.antelopejs` keeps the git module cache, its lock file, and the config for every worktree. The cache holds the same modules for all of them, and its lock file already orders its writes, so one copy saves disk and download time. The lease registry sits under `~/.antelopejs/leases` so that one registry serves every repository of the user. The mongod binaries in `~/.cache/mongodb-binaries` are shared too, but each lease runs its own mongod process on its own data directory.

## Fix an error

`antelopejs-lease` prints each failure as one line on stderr, prefixed with `antelopejs-lease:`, and exits with code 1. The command after `--` keeps its own exit code, and a command that cannot start exits with 127.

| The message says                                                   | What to do                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `<dir> is not inside a git worktree`                               | Run the command from inside the worktree.                                                                                       |
| `registry lock 127.0.0.1:20000 held for 15 s`                      | Another process holds the lock. Find it with the `ss` or `lsof` command the message prints. Stop it if it hangs, then retry.    |
| `no free port block in 20010-29999`                                | Run `antelopejs-lease gc`. Run `down` in the worktrees whose leases `status` lists and you no longer need. Then retry.          |
| `the lease of <path> belongs to an earlier checkout`               | The servers of a deleted or recreated worktree at this path still listen. Stop the pids the message names, then rerun.          |
| `<dir>/lease.json was written by another antelopejs-lease version` | Run the tooling-configs version that wrote it. Or delete the directory once no DMS uses it.                                     |
| `no mongod on PATH or in ~/.cache/mongodb-binaries`                | Install MongoDB, or set `DMS_MONGO_URL` to a server you run.                                                                    |
| `mongod did not answer on port <port>`                             | Read the end of the log the message names. It says why mongod stopped.                                                          |
| `mongod <pid> was still running 2 s after SIGKILL`                 | Check the process with `ps -p <pid>`. Retry once it is gone.                                                                    |
| `port <port> of this lease still listens`                          | Stop the servers with `dms-dev.sh stop` through `run --`, as in step 5. Then rerun `down`. To tear down anyway, pass `--force`. |
| `cannot run <command>`                                             | The command after `--` was not found. Check its name and your `PATH`.                                                           |
| Any message followed by a `usage:` line                            | Fix the arguments. The `usage:` line lists the valid forms.                                                                     |
