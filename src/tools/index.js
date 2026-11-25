/**
 * Tool registration wiring: registers all eight SciX tools and returns one
 * combined disposer. Registration is effect-based (brief §4.3): the entry
 * calls this inside ctx.effect and invokes the disposer on unload.
 * @module tools/index
 */
import { createSearchTool } from './search.js'
import { createGetPaperTool } from './get-paper.js'
import { createReadPaperTool } from './read-paper.js'
import { createCitationTraverseTool } from './citation-traverse.js'
import { createForwardCitationsTool } from './forward-citations.js'
import { createFindGapsTool } from './find-gaps.js'
import { createExportCitationTool } from './export-citation.js'
import { createManageLibraryTool } from './manage-library.js'

/**
 * Register every SciX tool on ctx.tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('../contracts/tools.js').ToolDeps} deps
 * @returns {() => void} disposer unregistering all eight tools (reverse order)
 */
export function registerAllTools(ctx, deps) {
  const disposers = [
    ctx.tools.register(createSearchTool(deps)),
    ctx.tools.register(createGetPaperTool(deps)),
    ctx.tools.register(createReadPaperTool(deps)),
    ctx.tools.register(createCitationTraverseTool(deps)),
    ctx.tools.register(createForwardCitationsTool(deps)),
    ctx.tools.register(createFindGapsTool(deps)),
    ctx.tools.register(createExportCitationTool(deps)),
    ctx.tools.register(createManageLibraryTool(deps)),
  ]
  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}