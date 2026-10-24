// Test-only hook recorder: keeps hook state across renders and runs effects whose dependencies changed, like React
// does after a commit, so a component's mount effects can be checked without a DOM.
import React from 'react';

type Row = Record<string, any>;
type Effect = { deps?: unknown[]; run: () => unknown };

export function hooks() {
  const states: unknown[] = [], refs: { current: unknown }[] = [], effects: Effect[] = [];
  let state = 0, ref = 0, effect = 0, pending: Effect['run'][] = [];
  const useState = (initial: unknown) => {
    const key = state++;
    if (!(key in states)) states[key] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [states[key], (next: unknown) => { states[key] = typeof next === 'function' ? (next as (value: unknown) => unknown)(states[key]) : next; }];
  };
  const useRef = (value: unknown) => refs[ref++] ||= { current: value };
  const useEffect = (run: Effect['run'], deps?: unknown[]) => {
    const key = effect++, previous = effects[key];
    if (!previous || !deps || !previous.deps || deps.some((value, index) => !Object.is(value, previous.deps![index]))) { effects[key] = { deps, run }; pending.push(run); }
  };
  const render = (component: (props: Row) => unknown, props: Row) => { state = ref = effect = 0; pending = []; return component(props); };
  const flush = () => { const queued = pending; pending = []; for (const run of queued) run(); };
  return { useState, useRef, useEffect, render, flush };
}
// Every element in a tree, including elements passed through props; components stay unrendered.
export const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : !React.isValidElement(node) ? [] : [node, ...Object.values(node.props as Row).flatMap(value => Array.isArray(value) || React.isValidElement(value) ? nodes(value) : [])];
