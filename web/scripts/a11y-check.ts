import { JSDOM } from 'jsdom';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AgentAvatar } from '../src/components/agent-avatar';

// Initialize JSDOM and globals BEFORE importing axe-core
const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body></body></html>');
global.window = dom.window as any;
global.document = dom.window.document;

// Use require to prevent import hoisting from loading axe-core before globals are set
const axe = require('axe-core');

/**
 * Runs axe-core on a rendered React component.
 * @param component The React element to evaluate
 * @param expectFail Set to true for negative testing
 */
async function runCheck(component: React.ReactElement, expectFail = false): Promise<boolean> {
  try {
    const html = renderToString(component);
    
    // Inject into the global document body
    document.body.innerHTML = `<main>${html}</main>`;
    
    // Ensure we fail closed on misconfigurations (like invalid document structure)
    if (!document.documentElement) {
       console.error("Accessibility Check Failed: Invalid document element.");
       return false;
    }

    const results = await axe.run(document.documentElement, {
      reporter: 'v2'
    });

    if (results.violations.length > 0) {
      if (expectFail) {
        return true; // Expected failure, pass the test
      }
      
      // CRITICAL PRIVACY REQUIREMENT: 
      // Do not log secrets, seeds, payment proofs, or sensitive data.
      // We only output generic, actionable, privacy-safe error messages.
      // We intentionally exclude v.nodes[].html which could contain sensitive DOM.
      console.error("Accessibility Check Failed.");
      console.error("Violations detected (privacy-safe report):");
      
      results.violations.forEach((v: any) => {
        console.error(`- Rule: ${v.id}`);
        console.error(`  Description: ${v.description}`);
        console.error(`  Help: ${v.helpUrl}`);
        console.error(`  Impact: ${v.impact}`);
        console.error(`  Count: ${v.nodes.length} element(s)`);
      });
      return false; // Test failed because it should have been accessible
    }

    if (expectFail) {
      console.error("Expected accessibility checks to fail on inaccessible fixture, but they passed.");
      return false;
    }
    
    return true; // Passed positive check
  } catch (err) {
    // Fails closed safely without exposing stack traces containing sensitive info
    console.error("An explicit misconfiguration or crash occurred in the accessibility runner.");
    console.error("Error: Generic runner failure. Check your configuration.");
    return false;
  }
}

async function main() {
  console.log("Starting Web Accessibility Checks...");
  let success = true;
  
  console.log("\\n[1/2] Running positive testing (accessible component)...");
  if (!await runCheck(React.createElement(AgentAvatar, { name: "TestAgent" }), false)) {
    success = false;
  }
  
  console.log("[2/2] Running negative/boundary testing (inaccessible component)...");
  const badComponent = React.createElement("div", null, 
    React.createElement("button", null), // Missing accessible text
    React.createElement("img", { src: "avatar.png" }) // Missing alt
  );
  if (!await runCheck(badComponent, true)) {
    success = false;
  }
  
  if (!success) {
    console.error("\\n[FAIL] Accessibility checks failed.");
    process.exit(1);
  } else {
    console.log("\\n[PASS] All accessibility checks passed.");
    process.exit(0);
  }
}

// Ensure the process explicitly fails closed on unhandled errors
main().catch(() => {
  console.error("Fatal error running accessibility checks. Failing closed.");
  process.exit(1);
});
