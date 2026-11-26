// Independent validation belongs to the tester's dispatched round. The immutable
// candidate comes from its approved inputs, never from a test report or branch tip.
import { field } from './project-plan.js'

export function beginValidation(card, round) {
  const binding = round.planNode
  const node = card.plans.at(-1).nodes[binding.node - 1]
  if (!node.independentReview || node.mergeToDev || node.writePaths?.length !== 0) return
  const candidates = [...new Set(binding.inputs.map(input => card.rounds[input.round - 1].mainReview?.commit).filter(Boolean))]
  if (!candidates.length) return
  const prior = card.rounds[binding.previousRound - 1]?.validation
  const sameCandidate = prior && candidates.length === prior.candidates.length && candidates.every(commit => prior.candidates.includes(commit))
  round.validation = { candidates, passed: sameCandidate ? structuredClone(prior.passed) : [] }
}

export function checkpointValidation(validation, args) {
  if (validation.cleanup && (args.passedCheck !== undefined || args.checking !== undefined)) throw new Error('Cleanup is already recorded for this validation.')
  if (args.passedCheck !== undefined) {
    const name = field(args.passedCheck, 'the completed check', 500)
    const evidence = field(args.evidence, 'the observed result or existing evidence location', 2000)
    const previous = validation.passed.find(check => check.name === name)
    if (previous && previous.evidence !== evidence) throw new Error('This check already has a different result.')
    if (!previous) validation.passed.push({ name, evidence, at: Date.now() })
    if (name === validation.checking) delete validation.checking
  }
  if (args.checking !== undefined) {
    const name = field(args.checking, 'the check now in progress', 500)
    if (!validation.passed.some(check => check.name === name)) {
      if (validation.checking && validation.checking !== name) throw new Error('Finish the current check before starting another.')
      validation.checking = name
    }
  }
  if (args.checksComplete === true) {
    if (validation.checking || !validation.passed.length) throw new Error('Finish the recorded checks before cleanup.')
    validation.checksComplete = true
  }
  if (validation.checking) delete validation.checksComplete
  if (args.cleanupEvidence !== undefined) recordCleanup(validation, args.cleanupEvidence)
}

function recordCleanup(validation, evidence) {
  if (validation.checking || !validation.passed.length) throw new Error('Record the completed checks before submitting validation.')
  const cleanup = field(evidence ?? validation.cleanup, 'the verified cleanup result', 2000)
  if (validation.cleanup && cleanup !== validation.cleanup) throw new Error('This round already has a different cleanup result.')
  validation.cleanup = cleanup
}

export function validationReceipt(validation, args) {
  if (args.commit || args.testedCommit || args.deliveryKind === 'code') throw new Error('The test candidate is already bound to this round.')
  recordCleanup(validation, args.cleanupEvidence)
  return ['Candidate: ' + validation.candidates.join(', '), ...validation.passed.map(check => check.name + ': ' + check.evidence), 'Cleanup: ' + validation.cleanup].join('\n')
}
