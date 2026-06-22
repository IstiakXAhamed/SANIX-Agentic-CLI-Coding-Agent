/**
 * @file coding/basic-coding.ts
 * @description 10 prompts testing basic code generation (factorial,
 * reverse linked list, binary search, FizzBuzz, etc.). Each prompt asks
 * for a small function in TypeScript. Scoring is `regex` looking for the
 * key algorithmic signature of a correct solution.
 *
 * @packageDocumentation
 */

import type { Benchmark } from '../../types.js';

/**
 * 10 basic coding prompts. Each asks the model to implement a small
 * algorithm; scoring checks for the canonical signature of a correct
 * implementation (e.g. a recursive call for `factorial`, a `mid`
 * reassignment for binary search).
 */
export const basicCoding: Benchmark = {
  id: 'basic-coding',
  name: 'Basic Coding',
  description:
    '10 prompts asking for small TypeScript function implementations (factorial, reverse linked list, binary search, etc.).',
  category: 'coding',
  scoring: { type: 'regex' },
  timeout: 120_000,
  prompts: [
    {
      id: 'c1',
      input: 'Implement a TypeScript function `factorial(n: number): number` that returns n!. Return only the function.',
      expected: 'function\\s+factorial',
    },
    {
      id: 'c2',
      input: 'Implement a TypeScript function to reverse a singly linked list. Use a `ListNode` interface with `val: number` and `next: ListNode | null`. Return only the function.',
      expected: 'reverse',
    },
    {
      id: 'c3',
      input: 'Implement a TypeScript function `binarySearch(arr: number[], target: number): number` that returns the index of `target` in a sorted array, or -1 if not found. Return only the function.',
      expected: 'mid',
    },
    {
      id: 'c4',
      input: 'Implement TypeScript `fizzbuzz(n: number): string[]` that returns the FizzBuzz sequence from 1 to n. Return only the function.',
      expected: 'Fizz',
    },
    {
      id: 'c5',
      input: 'Implement a TypeScript function `isPalindrome(s: string): boolean` that returns true iff `s` reads the same forwards and backwards (case-insensitive, ignoring non-alphanumeric). Return only the function.',
      expected: 'isPalindrome',
    },
    {
      id: 'c6',
      input: 'Implement a TypeScript function `fibonacci(n: number): number` returning the nth Fibonacci number (0-indexed: fib(0)=0, fib(1)=1). Return only the function.',
      expected: 'fibonacci',
    },
    {
      id: 'c7',
      input: 'Implement a TypeScript function `mergeSortedArrays(a: number[], b: number[]): number[]` that merges two already-sorted arrays. Return only the function.',
      expected: 'merge',
    },
    {
      id: 'c8',
      input: 'Implement a TypeScript function `debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T` that debounces `fn`. Return only the function.',
      expected: 'debounce',
    },
    {
      id: 'c9',
      input: 'Implement a TypeScript function `deepClone<T>(obj: T): T` that deep-clones a plain object (no class instances, no functions). Return only the function.',
      expected: 'deepClone',
    },
    {
      id: 'c10',
      input: 'Implement a TypeScript function `flatten(arr: any[]): any[]` that deeply flattens a nested array. Return only the function.',
      expected: 'flatten',
    },
  ],
};
