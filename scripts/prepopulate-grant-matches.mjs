#!/usr/bin/env node

import { db } from "../src/lib/firebase.js"
import {
  collection,
  query,
  where,
  getDocs,
  writeBatch,
  Timestamp,
  doc,
} from "firebase/firestore"

const TARGET_MATCH_SCORE = 80 // Changed from 85 to 80

async function prepopulateGrantMatches() {
  try {
    console.log("Starting grant matches prepopulation...")
    console.log(`Using TARGET_MATCH_SCORE: ${TARGET_MATCH_SCORE}`)

    const orgsRef = collection(db, "organizations")
    const orgsSnapshot = await getDocs(orgsRef)

    for (const orgDoc of orgsSnapshot.docs) {
      const orgId = orgDoc.id
      const orgData = orgDoc.data()

      console.log(`\nProcessing organization: ${orgData.name} (${orgId})`)

      console.log(`  Deleting existing auto-prepopulated grants...`)
      const existingGrantsRef = collection(db, "organizations", orgId, "grants")
      const existingGrantsQuery = query(
        existingGrantsRef,
        where("notes", ">=", "Auto-prepopulated"),
        where("notes", "<", "Auto-prepopulated\uf8ff"),
      )
      const existingGrantsSnapshot = await getDocs(existingGrantsQuery)

      if (existingGrantsSnapshot.size > 0) {
        const deleteBatch = writeBatch(db)
        existingGrantsSnapshot.docs.forEach((grantDoc) => {
          deleteBatch.delete(grantDoc.ref)
        })
        await deleteBatch.commit()
        console.log(`  Deleted ${existingGrantsSnapshot.size} existing auto-prepopulated grants`)
      }

      const grantsRef = collection(db, "grants")
      const grantsSnapshot = await getDocs(grantsRef)
      const allGrants = grantsSnapshot.docs.map((grantDoc) => ({
        id: grantDoc.id,
        ...grantDoc.data(),
      }))

      const matchedGrants = allGrants
        .map((grant) => {
          const matchScore = calculateMatchScore(orgData, grant)
          return {
            ...grant,
            matchScore,
          }
        })
        .filter((grant) => grant.matchScore >= TARGET_MATCH_SCORE)
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, 50)

      console.log(`  Found ${matchedGrants.length} grants matching at ≥${TARGET_MATCH_SCORE}%`)

      if (matchedGrants.length > 0) {
        const insertBatch = writeBatch(db)
        const orgGrantsRef = collection(db, "organizations", orgId, "grants")

        for (const grant of matchedGrants) {
          const duplicateSnapshot = await getDocs(query(orgGrantsRef, where("grantId", "==", grant.id)))

          if (duplicateSnapshot.empty) {
            const newGrantRef = doc(orgGrantsRef)
            insertBatch.set(newGrantRef, {
              grantId: grant.id,
              grantName: grant.title,
              matchScore: grant.matchScore,
              matchReasons: getMatchReasons(orgData, grant),
              notes: `Auto-prepopulated at ${new Date().toISOString()}`,
              amount: calculateGrantAmount(grant),
              createdAt: Timestamp.now(),
              source: "auto-prepopulated",
            })
          }
        }

        await insertBatch.commit()
        console.log(`  Inserted ${matchedGrants.length} new auto-prepopulated grants`)
      }
    }

    console.log("\nGrant matches prepopulation completed successfully!")
  } catch (error) {
    console.error("Error during grant matches prepopulation:", error)
    throw error
  }
}

function calculateMatchScore(orgData, grant) {
  let score = 0
  const weights = {
    sector: 15,
    geoMatch: 20,
    budgetMatch: 25,
    eligibility: 20,
    fundingType: 20,
  }

  if (
    orgData.sectors &&
    grant.sectors &&
    orgData.sectors.some((sector) => grant.sectors.includes(sector))
  ) {
    score += weights.sector
  }

  if (orgData.state && grant.states && grant.states.includes(orgData.state)) {
    score += weights.geoMatch
  }

  if (orgData.annualBudget && grant.maxAmount) {
    const budgetRatio = orgData.annualBudget / grant.maxAmount
    if (budgetRatio >= 0.5 && budgetRatio <= 2) {
      score += weights.budgetMatch
    } else if (budgetRatio >= 0.25 && budgetRatio <= 4) {
      score += weights.budgetMatch * 0.5
    }
  }

  if (orgData.type && grant.eligibleTypes && grant.eligibleTypes.includes(orgData.type)) {
    score += weights.eligibility
  }

  if (orgData.fundingTypes && grant.fundingType && orgData.fundingTypes.includes(grant.fundingType)) {
    score += weights.fundingType
  }

  return Math.round(score)
}

function getMatchReasons(orgData, grant) {
  const reasons = []

  if (
    orgData.sectors &&
    grant.sectors &&
    orgData.sectors.some((sector) => grant.sectors.includes(sector))
  ) {
    reasons.push("Sector match")
  }

  if (orgData.state && grant.states && grant.states.includes(orgData.state)) {
    reasons.push("Geographic match")
  }

  if (orgData.type && grant.eligibleTypes && grant.eligibleTypes.includes(orgData.type)) {
    reasons.push("Organization type eligible")
  }

  if (orgData.fundingTypes && grant.fundingType && orgData.fundingTypes.includes(grant.fundingType)) {
    reasons.push("Funding type match")
  }

  return reasons
}

function calculateGrantAmount(grant) {
  if (grant.minAmount && grant.maxAmount) {
    return (grant.minAmount + grant.maxAmount) / 2
  }
  return grant.maxAmount || grant.minAmount || 0
}

prepopulateGrantMatches().catch(console.error)
