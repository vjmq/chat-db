import { makeSourceUtils } from '../../utils'

export let { writeFileSync, log } = makeSourceUtils({ source: 'email' })
