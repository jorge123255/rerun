import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.RERUN_DESKTOP_UI_ROOT
if (!root || !process.send || !process.env.RERUN_DESKTOP_RUNTIME_FILE) throw new Error('UI host requires a managed desktop launch')
const stop = () => process.kill(process.pid, 'SIGTERM')
process.once('disconnect', stop)
process.on('message', message => { if (message?.type === 'stop') stop() })
process.chdir(root)
await import(pathToFileURL(resolve(root, 'server.js')).href)
