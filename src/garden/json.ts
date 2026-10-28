export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

/** Raised when an API payload lacks a field the Gardener relies on. */
class DecodeError extends Error {}

export function isString(value: JsonValue): value is string {
  return String(value) === value;
}

function isNumber(value: JsonValue): value is number {
  return Number.isFinite(value);
}

export function isObject(value: JsonValue): value is JsonObject {
  return Object(value) === value && !Array.isArray(value);
}

export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

export function object(value: JsonValue, path: string): JsonObject {
  if (!isObject(value)) throw new DecodeError(`${path}: expected an object`);
  return value;
}

export function list(value: JsonValue, path: string): JsonValue[] {
  if (!Array.isArray(value)) throw new DecodeError(`${path}: expected a list`);
  return value;
}

export function str(source: JsonObject, key: string): string {
  const value = source[key];
  if (value === undefined || !isString(value))
    throw new DecodeError(`${key}: expected a string`);
  return value;
}

export function optStr(source: JsonObject, key: string): string | undefined {
  const value = source[key];
  return value !== undefined && isString(value) ? value : undefined;
}

export function num(source: JsonObject, key: string): number {
  const value = source[key];
  if (value === undefined || !isNumber(value))
    throw new DecodeError(`${key}: expected a number`);
  return value;
}

export function optNum(source: JsonObject, key: string): number | undefined {
  const value = source[key];
  return value !== undefined && isNumber(value) ? value : undefined;
}

export function flag(source: JsonObject, key: string): boolean {
  return source[key] === true;
}

export function child(source: JsonObject, key: string): JsonObject {
  const value = source[key];
  return value === undefined ? {} : object(value, key);
}

export function children(source: JsonObject, key: string): JsonObject[] {
  const value = source[key];
  return value === undefined
    ? []
    : list(value, key).map((entry) => object(entry, key));
}

export function strings(source: JsonObject, key: string): string[] {
  const value = source[key];
  return value === undefined
    ? []
    : list(value, key).filter((entry) => isString(entry));
}

export function time(source: JsonObject, key: string): number {
  const value = Date.parse(str(source, key));
  if (Number.isNaN(value)) throw new DecodeError(`${key}: expected a date`);
  return value;
}

export function optTime(source: JsonObject, key: string): number | undefined {
  const value = optStr(source, key);
  return value === undefined ? undefined : Date.parse(value);
}
