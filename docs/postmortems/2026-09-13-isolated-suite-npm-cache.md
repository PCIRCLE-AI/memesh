# Isolated release suite inherited the maintainer npm cache

**Date:** 2026-09-13
**Affected release:** pre-release 4.10 candidate
**Surface:** `npm run test:isolated`

## Symptom

The isolated test suite reached its packaged plugin test, then failed with
`EPERM` while `npm pack` tried to open a temporary file in the
maintainer's `~/.npm` cache.

## Root cause

The suite replaced `HOME` and removed MeMesh paths and common model
credentials, but it did not replace an inherited npm cache setting. Nested npm
processes could therefore leave the throwaway test home and use owner state.

## Why existing gates missed it

The isolation contract asserted the temporary home, MeMesh paths, and model
credential removal. It did not assert that the runner passed a private npm
cache to all nested tests. Machines with a healthy default npm cache stayed
green.

## Gate added

The isolated runner now passes a cache under its temporary home through the
existing case-insensitive `envWithNpmCache` helper. A source contract requires
that wiring, and the full isolated suite exercises the nested `npm pack` path.
