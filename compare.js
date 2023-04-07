#!/usr/bin/env node
/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

const originalFilesize = require('filesize')
const numberToWords = require('number-to-words')
const fs = require('fs')
const path = require('path')
const { getBuildOutputDirectory, getOptions } = require('./utils')

// Override default filesize options to display a non-breakable space as a spacer.
const filesize = (bytes, options) => {
  return originalFilesize(bytes, {
    spacer: ' ',
    ...options,
  })
}

// Pull options from `package.json`
const options = getOptions()

const BUDGET = options.budget
const BUDGET_PERCENT_INCREASE_RED = options.budgetPercentIncreaseRed
// this must be explicitly set to false not to render
const SHOW_DETAILS =
  options.showDetails === undefined ? true : options.showDetails
const BUILD_OUTPUT_DIRECTORY = getBuildOutputDirectory(options)
const PACKAGE_NAME = options.name
const SKIP_COMMENT_IF_EMPTY = options.skipCommentIfEmpty

// import the current and base branch bundle stats
const currentBundle = require(path.join(
  process.cwd(),
  BUILD_OUTPUT_DIRECTORY,
  'analyze/__bundle_analysis.json'
))
const baseBundle = require(path.join(
  process.cwd(),
  BUILD_OUTPUT_DIRECTORY,
  'analyze/base/bundle/__bundle_analysis.json'
))

// kick it off
let output = `## 📦 Next.js Bundle Analysis for ${PACKAGE_NAME}

This analysis was generated by the [Next.js Bundle Analysis action](https://github.com/hashicorp/nextjs-bundle-analysis). 🤖

`

// pull the global bundle out, we handle this separately
const globalBundleCurrent = currentBundle.__global
const globalBundleBase = baseBundle.__global
delete currentBundle.__global
delete baseBundle.__global

// calculate the difference between the current bundle and the base branch's
let globalBundleChanges = false
const globalGzipDiff = globalBundleCurrent.gzip - globalBundleBase.gzip
// only report a global bundle size change if we don't have a minimum change
// threshold configured, or if the change is greater than the threshold
if (
  globalGzipDiff !== 0 &&
  (!('minimumChangeThreshold' in options) ||
    Math.abs(globalGzipDiff) > options.minimumChangeThreshold)
) {
  globalBundleChanges = {
    page: 'global',
    raw: globalBundleCurrent.raw,
    gzip: globalBundleCurrent.gzip,
    gzipDiff: globalGzipDiff,
    increase: Math.sign(globalGzipDiff) > 0,
  }
}

// now we're going to go through each of the pages in the current bundle and
// run analysis on each one.
const changedPages = []
const newPages = []

for (let page in currentBundle) {
  const currentStats = currentBundle[page]
  const baseStats = baseBundle[page]

  // if the page does't appear in the base bundle, it is a new page, we can
  // push this directly to its own category. we also don't compare it to anything
  // because its a new page.
  if (!baseStats) {
    newPages.push({ page, ...currentStats })
  } else if (currentStats.gzip !== baseStats.gzip) {
    // otherwise, we run a comparsion between the current page and base branch page
    // we push these to their own category for rendering later
    const rawDiff = currentStats.raw - baseStats.raw
    const gzipDiff = currentStats.gzip - baseStats.gzip
    const increase = !!Math.sign(gzipDiff)
    // only report a page size change if we don't have a minimum change
    // threshold configured, or if the change is greater than the threshold
    if (
      !('minimumChangeThreshold' in options) ||
      Math.abs(gzipDiff) > options.minimumChangeThreshold
    ) {
      changedPages.push({ page, ...currentStats, rawDiff, gzipDiff, increase })
    }
  }
}

// with our data in hand, we now get to a bunch of output formatting.
// we start with any changes to the global bundle.
if (globalBundleChanges) {
  // start with the headline, which will render differently depending on whether
  // there was an increase of decrease.
  output += `### ${
    globalBundleChanges.increase ? '⚠️' : '🎉'
  }  Global Bundle Size ${
    globalBundleChanges.increase ? 'Increased' : 'Decreased'
  }
  
`
  // this is where we actually generate the table including the changes.
  output += markdownTable(globalBundleChanges)

  // and we end with some extra details further explaining the data above
  if (SHOW_DETAILS) {
    output += `\n<details>
<summary>Details</summary>
<p>The <strong>global bundle</strong> is the javascript bundle that loads alongside every page. It is in its own category because its impact is much higher - an increase to its size means that every page on your website loads slower, and a decrease means every page loads faster.</p>
<p>Any third party scripts you have added directly to your app using the <code>&lt;script&gt;</code> tag are not accounted for in this analysis</p>
<p>If you want further insight into what is behind the changes, give <a href='https://www.npmjs.com/package/@next/bundle-analyzer'>@next/bundle-analyzer</a> a try!</p>
</details>\n\n`
  }
}

// next up is the newly added pages
if (newPages.length) {
  // this might seem like too much, but I feel like this type of small detail really
  // matters <3
  const plural = newPages.length > 1 ? 's' : ''
  output += `### New Page${plural} Added
  
The following page${plural} ${
    plural === 's' ? 'were' : 'was'
  } added to the bundle from the code in this PR:

`
  // as before, run the data in as a table
  output += markdownTable(newPages, globalBundleCurrent) + '\n'

  // there is no "details" section here, didnt't seem necessary. i'm open to one being
  // added though!
}

// finally, we run through the pages that existed in the base branch, still exist in the
// current branch, and have changed size.
if (changedPages.length) {
  // same flow here as the others:
  // - headline that adjusts wording based on number of changes
  // - table containing all the resources and info
  // - details section
  const plural = changedPages.length > 1 ? 's' : ''
  output += `### ${titleCase(
    numberToWords.toWords(changedPages.length)
  )} Page${plural} Changed Size
  
The following page${plural} changed size from the code in this PR compared to its base branch:

`
  output += markdownTable(changedPages, globalBundleCurrent, globalBundleBase)

  // this details section is a bit more responsive, it will render slightly different
  // details depending on whether a budget is being used, since the information presented
  // is quite different.
  if (SHOW_DETAILS) {
    output += `\n<details>
<summary>Details</summary>
<p>Only the gzipped size is provided here based on <a href='https://twitter.com/slightlylate/status/1412851269211811845'>an expert tip</a>.</p>
<p><strong>First Load</strong> is the size of the global bundle plus the bundle for the individual page. If a user were to show up to your website and land on a given page, the first load size represents the amount of javascript that user would need to download. If <code>next/link</code> is used, subsequent page loads would only need to download that page's bundle (the number in the "Size" column), since the global bundle has already been downloaded.</p>
<p>Any third party scripts you have added directly to your app using the <code>&lt;script&gt;</code> tag are not accounted for in this analysis</p>
${
  BUDGET && globalBundleCurrent
    ? `<p>The "Budget %" column shows what percentage of your performance budget the <strong>First Load</strong> total takes up. For example, if your budget was 100kb, and a given page's first load size was 10kb, it would be 10% of your budget. You can also see how much this has increased or decreased compared to the base branch of your PR. If this percentage has increased by ${BUDGET_PERCENT_INCREASE_RED}% or more, there will be a red status indicator applied, indicating that special attention should be given to this. If you see "+/- <0.01%" it means that there was a change in bundle size, but it is a trivial enough amount that it can be ignored.</p>`
    : `<p>Next to the size is how much the size has increased or decreased compared with the base branch of this PR. If this percentage has increased by ${BUDGET_PERCENT_INCREASE_RED}% or more, there will be a red status indicator applied, indicating that special attention should be given to this.`
}
</details>\n`
  }
}

// and finally, if there are no changes at all, we try to be clear about that
const hasNoChanges =
  !newPages.length && !changedPages.length && !globalBundleChanges
if (hasNoChanges) {
  output += 'This PR introduced no changes to the JavaScript bundle! 🙌'
}

// we add this tag so that our action can be able to easily and consistently find the
// right comment to edit as more commits are pushed.
output += `<!-- __NEXTJS_BUNDLE_${PACKAGE_NAME} -->`

// however, if ignoreIfEmpty is true, set output to an empty string
if (hasNoChanges && SKIP_COMMENT_IF_EMPTY) {
  output = ''
}

// log the output, mostly for testing and debugging. this will show up in the
// github actions console.
console.log(output)

// and to cap it off, we write the output to a file which is later read in as comment
// contents by the actions workflow.
fs.writeFileSync(
  path.join(
    process.cwd(),
    BUILD_OUTPUT_DIRECTORY,
    'analyze/__bundle_analysis_comment.txt'
  ),
  output.trim()
)

// Util Functions

// this is where the vast majority of the complexity lives, its a single function
// that renders a markdown table displaying a wide range of bundle size data in a
// wide variety of different ways. this could potentially be improved by splitting it
// up into several different functions for rendering the different tables we produce
// (new pages, changed pages, global bundle)
function markdownTable(_data, globalBundleCurrent, globalBundleBase) {
  const data = [].concat(_data)
  // the table renders different depending on whether the budget option is enabled
  // and also some tables do not run budget diffs (new, global)
  const showBudget = globalBundleCurrent && BUDGET
  const showBudgetDiff = BUDGET && !!globalBundleBase

  // first we set up the table headers
  return `Page | Size (compressed) | ${
    globalBundleCurrent ? `First Load |` : ''
  }${showBudget ? ` % of Budget (\`${filesize(BUDGET)}\`) |` : ''}
|---|---|${globalBundleCurrent ? '---|' : ''}${showBudget ? '---|' : ''}
${data
  .map((d) => {
    // next, we go through each item in the bundle data that was passed in and render
    // a row for it. a couple calculations are run upfront to make rendering easier.
    const firstLoadSize = globalBundleCurrent
      ? d.gzip + globalBundleCurrent.gzip
      : 0

    const budgetPercentage = showBudget
      ? ((firstLoadSize / BUDGET) * 100).toFixed(2)
      : 0
    const previousBudgetPercentage =
      globalBundleBase && d.gzipDiff
        ? (
            ((globalBundleCurrent.gzip + d.gzip + d.gzipDiff) / BUDGET) *
            100
          ).toFixed(2)
        : 0
    const budgetChange = previousBudgetPercentage
      ? (previousBudgetPercentage - budgetPercentage).toFixed(2)
      : 0

    return (
      `| \`${d.page}\`` +
      renderSize(d, showBudgetDiff) +
      renderFirstLoad(globalBundleCurrent, firstLoadSize) +
      renderBudgetPercentage(
        showBudget,
        budgetPercentage,
        previousBudgetPercentage,
        budgetChange
      ) +
      ' |\n'
    )
  })
  .join('')}`
}

// as long as global bundle is passed, render the first load size, which is the global
// bundle plus the size of the current page, representing the total JS required
// in order to land on that page.
function renderFirstLoad(globalBundleCurrent, firstLoadSize) {
  if (!globalBundleCurrent) return ''
  return ` | ${filesize(firstLoadSize)}`
}

// renders the bundle size of the current page. if there is a diff from the base branch
// size of the page, also displays the size difference, unless there is a budget set and
// the budget has a diff from the base branch, in which case the diff is not rendered.
function renderSize(d, showBudgetDiff) {
  const gzd = d.gzipDiff
  const percentChange = (gzd / d.gzip) * 100
  return ` | \`${filesize(d.gzip)}\`${
    gzd && !showBudgetDiff
      ? ` _(${renderStatusIndicator(percentChange)}${filesize(gzd)})_`
      : ''
  }`
}

// renders the percentage of the budget taken up by the current page's first load js
// for changed pages, also renders the percent change compared to the base branch size
function renderBudgetPercentage(
  showBudget,
  budgetPercentage,
  previousBudgetPercentage,
  budgetChange
) {
  if (!showBudget) return ''

  // we round to 2 decimal places for number values, if there was a change smaller than that
  // its displayed as "+/- <0.01%", signaling that it's not a consequential change, but it
  // still is a change technically, so we still show it.
  const budgetChangeText = ` _(${renderStatusIndicator(budgetChange)}${
    budgetChange < 0.01 && budgetChange > -0.01
      ? '+/- <0.01%'
      : budgetChange + '%'
  })_`

  // only render the budget change for changed pages (indicated by previousBudgetPercentage
  // being passed in)
  return ` | ${budgetPercentage}%${
    previousBudgetPercentage ? budgetChangeText : ''
  }`
}

// given a percentage that a metric has changed, renders a colored status indicator
// this makes it easier to call attention to things that need attention
//
// in general:
// - yellow means "keep an eye on this"
// - red means "this is a problem"
// - green means "this is a win"
function renderStatusIndicator(percentageChange) {
  let res = ''
  if (percentageChange > 0 && percentageChange < BUDGET_PERCENT_INCREASE_RED) {
    res += '🟡 +'
  } else if (percentageChange >= BUDGET_PERCENT_INCREASE_RED) {
    res += '🔴 +'
  } else if (percentageChange < 0.01 && percentageChange > -0.01) {
    res += ''
  } else {
    res += '🟢 '
  }
  return res
}

function titleCase(str) {
  return str.replace(/\w\S*/g, (txt) => {
    return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
  })
}
