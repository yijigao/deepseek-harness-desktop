'use strict'

const { isolatedValidationTimeoutMs } = require('../app/lib/verification-contract')
const mode = process.argv[2]
if (!mode) throw new Error('Usage: node verification-contract.cjs <--verify|--shot|--verify-engine-recovery>')
process.stdout.write(`${JSON.stringify({ mode, timeoutMs: isolatedValidationTimeoutMs(mode) })}\n`)
