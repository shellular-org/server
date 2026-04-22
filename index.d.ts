declare global {
	type Condition<T> = Partial<T> & {
		$scope?: string;
		$or?: Condition<T>[];
		$not?: Condition<T>;
		$in?: { [K in keyof T]?: T[K][] };
		$notIn?: { [K in keyof T]?: T[K][] };
	};

	type JoinCondition<T> = Partial<Record<keyof T, string>> & {
		$scope?: string;
		$or?: JoinCondition<T>[];
		$not?: JoinCondition<T>;
	};

	type JoinOptions<T> = {
		columns: (keyof T)[];
		on: JoinCondition<T>;
		table: string;
		type?: "inner" | "left" | "right";
	};

	type UpdateProps<T> = Partial<T> & {
		$inc?: Array<keyof T> | keyof T;
		$dec?: Array<keyof T> | keyof T;
		$add?: Partial<Record<keyof T, number>>;
		$sub?: Partial<Record<keyof T, number>>;
	};
}
