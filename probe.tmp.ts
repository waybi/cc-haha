import { getContextWindowForModel, modelSupports1M } from './src/utils/context.js'
import { getMarketingNameForModel } from './src/utils/model/model.js'

for (const id of ['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8']) {
  console.log(id, '| 1M:', modelSupports1M(id), '| ctx:', getContextWindowForModel(id), '| name:', getMarketingNameForModel(id))
}
