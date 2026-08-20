import 'dotenv/config'
import { seedIfEmpty } from './seed.js'
import app from './app.js'

const port = Number(process.env.PORT) || 4100
await seedIfEmpty()

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`people_backend listening on http://localhost:${port}`)
})
server.on('error', (err) => {
  console.error(err)
  process.exit(1)
})
